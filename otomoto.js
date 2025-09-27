const fs = require('node:fs/promises');
const qs = require('querystring');
const { DateTime } = require('luxon');
const DATE_FORMAT = 'dd.MM.yyyy';
const {default: axiosRetry, isNetworkOrIdempotentRequestError } = require('axios-retry');
const axios = require('axios');
const cheerio = require('cheerio');
const api_key = process.env.API_KEY;
const DEBUG = process.env.DEBUG;
const onlyYear = process.argv[2];

(async function main() {
	const config = JSON.parse(await fs.readFile('config.json'));
	const listingDir = config.listing.dir;
	const listingUrls = config.listing.urls;
	const today = DateTime.now().toFormat(DATE_FORMAT);
	const auctionsDir = listingDir + '/' + today;
	const imagesDir = './images';
	
	axiosRetry(axios, { 
		retries: 3,
		onRetry: (retryCount, error) => {
			console.error(`Retrying #${retryCount}`, error.response.status);
		},
		retryCondition: error => error.response.status >= 400
	});

	await fs.mkdir(auctionsDir, { recursive: true });
	await fs.mkdir(imagesDir, { recursive: true });

	if (DEBUG) {
		await fs.mkdir('./DEBUG', { recursive: true });
	}

	for (const {url, year, kind = 'otomoto'} of listingUrls) {
		console.log(`Listing year ${year}`);
		console.log(`Getting list of auctions ${kind}`);
		const debugFilename = `./DEBUG/${year}.html`;
		let data = {};
		try {
			let download = true;
			if (DEBUG) {
				try {
					await fs.access(debugFilename);
					download = false;
				} catch {
					download = true;
				}
			}
			if (download) {
				data = (await axios.get(getScrapeUrl(url) + (kind == 'mobile.de' ? '&residential=true' : ''))).data;
				if (DEBUG) {
					console.debug(`Writing ${debugFilename}`);''
					await fs.writeFile(debugFilename, data);
				}
			} else {
				console.debug(`Reading ${debugFilename}`);
				data = await fs.readFile(debugFilename)
			}
		} catch(e) {
			if (DEBUG) {
				throw e;
			} else {
				console.error(e.response.data);
			}
		}
		const $ = cheerio.load(data);
		const auctions = [];

		if (kind == 'otomoto') {
			const articles = $('article').toArray();

			let auctionIdx = 0;
			for (const el of articles) {
				const jqSection = $(el).children('section');
				const jqDivs = jqSection.children('div');

				const thumbnailUrl = jqDivs.eq(0).find('img').attr('src');
				const url = jqDivs.find('a').eq(0).attr('href');
				const mileage = jqDivs.eq(2).children('dl').eq(0).children('dd').eq(0).text();
				const location = jqDivs.eq(2).children('dl').eq(1).children('dd').eq(0).children('p').text();

				if (thumbnailUrl && url) {
					console.log(`Getting details of auction #${auctionIdx + 1}`);
					try {
					  const details = await getAuctionDetails(url, { kind });
					  const auction = { thumbnailUrl, url, mileage, location, ...details };
					  auctions.push(auction);
					} catch (e) {
					  console.error(`Error auction #${auctionIdx + 1}: ${e}`);
					}
					auctionIdx++;
				}
			}
		} else if (kind == 'mobile.de') {
			let auctionIdx = 0;
			let src = $('div#root + script').eq(0).text();
			src = src.substring(0, src.indexOf('window.__PUBLIC_CONFIG__')).replace('window.__INITIAL_STATE__ = ', '');
			if (!src) {
				continue;
			}
			const data = JSON.parse(src);
			const items = data.search.srp.data.searchResults.items.filter(item => item.vc == 'Car');
			for (const item of items) {
				try {
					const thumbnailUrl = item.previewImage.srcSet.split(', ').at(-1).replace(/ .*$/, '');
					const url = 'https://suchen.mobile.de/fahrzeuge/details.html?id=' + item.id;
					const mileage = item.attr.ml;
					const location = item.attr.loc;
					const country = item.attr.cn;

					console.log(`Getting details of auction #${auctionIdx + 1}`);
					const details = await getAuctionDetails(url, { kind, mobileItemId: item.id });
					const auction = { thumbnailUrl, url, mileage, location, country, year, ...details };
					auctions.push(auction);
				} catch (e) {
				  console.error(`Error auction #${auctionIdx + 1}: ${e}`);
				}
				auctionIdx++;
			}
		}

		for (const [idx, auction] of auctions.entries()) {
			const auctionJson = JSON.stringify(auction, null, 2);
			await fs.writeFile(`${auctionsDir}/${auction.id}.json`, auctionJson);
			console.log(`Saving images auction ${idx + 1}/${auctions.length}`);
			await saveImagesFromAuction(imagesDir, auction);
		}

	}
})().catch(e => console.error(e));

function getScrapeUrl(url) {
	const proxyParams = { api_key: api_key, url: url };
	const proxyUrl = 'https://proxy.scrapeops.io/v1/?' + qs.stringify(proxyParams);

	return proxyUrl;
}

async function getAuctionDetails(url, { kind, mobileItemId }) {
	const debugFilename = './DEBUG/' + url.replaceAll(/[/:]/g, '_');
	let data = {};
	try {
		let download = true;
		if (DEBUG) {
			try {
				await fs.access(debugFilename);
				download = false;
			} catch {
				download = true;
			}
		}
		if (download) {
			data = (await axios.get(getScrapeUrl(url))).data;
			if (DEBUG) {
				console.debug(`Writing ${debugFilename}`);
				await fs.writeFile(debugFilename, data);
			}
		} else {
			console.debug(`Reading ${debugFilename}`);
			data = await fs.readFile(debugFilename)
		}
	} catch(e) {
		throw e.response.data;
	}
	
	return new Promise(resolve => {
		const $ = cheerio.load(data);
		let year, title, description, fullDescription, price, priceTargeting, currency, date, id, imgUrls;

		if (kind == 'otomoto') {
			const pageProps = JSON.parse($('#__NEXT_DATA__').eq(0).text()).props.pageProps;
			const advert = pageProps.advert;

			year = parseInt(advert.parametersDict.year.values[0].value);
			title = advert.title;
			description = '';
			fullDescription = advert.description;
			price = advert.price.value;
			priceTargeting = (pageProps.baseTargeting?.price[0].split('-') ?? [null, null])
				.reduce((acc, value, idx) => Object.defineProperty(acc, idx ? 'max' : 'min', { value, enumerable: true }), {});
			date = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'long', timeStyle: 'short' })
				.format(new Date(advert.createdAt));
			id = advert.id;
			imgUrls = advert.images.photos.map(p => p.url);
		} else if (kind == 'mobile.de') {
			let src = $('div#root + script').eq(0).text();
			src = src.substring(0, src.indexOf('window.__PUBLIC_CONFIG__')).replace('window.__INITIAL_STATE__ = ', '');
			const item = JSON.parse(src);
			const ad = item.search.vip.ads[mobileItemId];
			title = ad.data.ad.title;
			description = '';
			fullDescription = ad.data.ad.htmlDescription;
			price = ad.data.ad.price.grossAmount + '';
			currency = ad.data.ad.price.grossCurrency;
			date = '';
			id = mobileItemId;
			imgUrls = ad.data.ad.galleryImages.map(p => p.srcSet.split(', ').at(-1).replace(/ .*$/, ''));
		}

		resolve({ year, title, description, fullDescription, price, priceTargeting, currency, date, id, imgUrls });
	});
}

function saveImagesFromAuction(dir, auction) {
	const { id, imgUrls } = auction;
	const results = [];
	for (const [idx, imgUrl] of imgUrls.entries()) {
		results.push(saveImage(imgUrl, `${dir}/${id}_${idx + 1}.webp`));
	}
	return Promise.all(results);
}

async function saveImage(url, filename) {
	try {
		const { data } = await axios.get(url, { responseType: 'arraybuffer' });
		return fs.writeFile(filename, data);
	} catch(e) {
		console.error(e);
	}
}
