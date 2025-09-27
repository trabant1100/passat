const fs = require('node:fs/promises');
const fn = require('./chart.js');
const { DateTime, Interval } = require('luxon');
const DATE_FORMAT = 'dd.MM.yyyy';
const pug = require('pug');
const today = process.argv[2] ?? DateTime.now().toFormat(DATE_FORMAT);

(async function main() {
	const config = JSON.parse(await fs.readFile('config.json'));
	const listingDir = config.listing.dir;
	const { dir: reportDir, banned_urls: bannedUrls, crashed_urls: crashedUrls, fav_urls: favUrls, dead_urls: deadUrls, 
		relisted_urls: relistedUrls, vins, notes } = config.report;

	const report = await generateReport(today, relistedUrls, vins, normalizeNotes(notes), listingDir, { bannedUrls, crashedUrls, favUrls, deadUrls });
	console.log('Writing report json');
	await fs.mkdir(reportDir, { recursive: true });
	await fs.writeFile(`${reportDir}/${today}.json`, JSON.stringify(report, null, 2));

	const html = await createHtml(normalizeReport(report), listingDir, { bannedUrls, crashedUrls, favUrls, deadUrls });
	console.log('Writing report html');
	await fs.writeFile(`${reportDir}/${today}.html`, html);

	console.log('Writing redirect html');
	await fs.writeFile('index.html', createRedirectHtml(reportDir, today));
})();

function normalizeReport(report) {
	const normalized = JSON.parse(JSON.stringify(report));

	for (const [auctionId, auction] of Object.entries(normalized)) {
		auction.year = auction.snapshots.at(-1).year ?? 2020;
		for (const snapshot of auction.snapshots) {
			snapshot.price = Number.parseInt(snapshot.price.replace(' ', ''));
			if (snapshot.priceTargeting) {
				snapshot.priceTargeting = {
					price: parseInt(snapshot.price),
					...Object.fromEntries(Object.entries(snapshot.priceTargeting).map(([k, v]) => [k, parseInt(v)]))
				}
			}
		}
	}

	const groupedByYear = [];
	for (const [auctionId, auction] of Object.entries(normalized)) {
		groupedByYear[auction.year] = groupedByYear[auction.year] ?? {};
		groupedByYear[auction.year][auctionId] = auction;
	}

	return groupedByYear
		.reduce((acc, group) => {
			acc = { ...acc, ...group };
			return acc;
	}, {});
}

function normalizeNotes(notes) {
	const normalized = JSON.parse(JSON.stringify(notes));

	for (const [url, note] of Object.entries(normalized)) {
		if (note.price) {
			for (const [currency, price] of Object.entries(note.price)) {
				let normalizedPrice = {};
				if (typeof price == 'number') {
					normalizedPrice = { date: undefined, value: price };
				} else {
					normalizedPrice = { date: price.date, value: price.value };
				}
				note.price[currency] = normalizedPrice;
			}
		}
	}

	return normalized;
}

async function generateReport(today, relistedUrls, vins, notes, rootDir, { bannedUrls, crashedUrls, favUrls, deadUrls }) {
	const listingDirs = [];
	console.log('Processing listings');
	for (const filename of await fs.readdir(rootDir)) {
		const fullFilename = `${rootDir}/${filename}`;
		const stat = await fs.stat(fullFilename);
		if (stat.isDirectory() && /\d\d.\d\d.\d{4}/.test(filename)) {
			listingDirs.push(filename);
		}
	}
	listingDirs.sort((fname1, fname2) => {
		const date1 = DateTime.fromFormat(fname1, DATE_FORMAT);
		const date2 = DateTime.fromFormat(fname2, DATE_FORMAT);
		
		return date1.toMillis() - date2.toMillis();
	});

	const report = {};

	console.log('Processing auction files');
	for (const listingDir of listingDirs) {
		const fullListingDir = `${rootDir}/${listingDir}`;
		for (const filename of await fs.readdir(fullListingDir)) {
			const fullFilename = `${rootDir}/${listingDir}/${filename}`;
			const stat = await fs.stat(fullFilename);
			if (stat.isFile() && filename.endsWith('.json')) {
				const auction = JSON.parse(await fs.readFile(fullFilename));
				auction.snapshotDate = listingDir;
				if (report[auction.id] === undefined) {
					report[auction.id] = { snapshots: [] };
				}
				report[auction.id].snapshots.push(auction);
			}
		}
	}

	const relistedAuctions = [];
	for (const [auctionId, auction] of Object.entries(report)) {
		const lastSnapshot = auction.snapshots.at(-1);
		const url = lastSnapshot.url;
		for (const [i, urls] of Object.entries(relistedUrls)) {
			if (relistedAuctions[i] === undefined) {
				relistedAuctions[i] = [];
			}
			if (urls.includes(url)) {
				const auction = getAuctionByUrl(url);
				relistedAuctions[i].push(auction);
			}
		}
	}

	for (const auctions of relistedAuctions) {
		if (auctions.length == 0) {
			continue;
		}
		auctions.sort((auction1, auction2) => {
			const date1 = DateTime.fromFormat(auction1.snapshots.at(-1).snapshotDate, DATE_FORMAT);
			const date2 = DateTime.fromFormat(auction2.snapshots.at(-1).snapshotDate, DATE_FORMAT);
			
			return date1.toMillis() - date2.toMillis();
		});
		const allUrls = auctions.map(auction => auction.snapshots.at(-1).url);
		for (const auction of auctions) {
			for (const snapshot of auction.snapshots) {
				snapshot.alternateUrls = allUrls;
			}
		}
		const lastAuction = auctions.at(-1);
		report[lastAuction.snapshots.at(-1).id].snapshots = auctions.flatMap(auction => auction.snapshots);
	}

	for (const auctionId in report) {
		const auction = report[auctionId];
		const snapshots = auction.snapshots;
		const lastSnapshot = snapshots.at(-1);
		if (lastSnapshot.snapshotDate != today) {
			auction.ended = true;
		}
		if (snapshots.length == 1 && snapshots[0].snapshotDate == today) {
			auction.new = true;
		}

		const urls = lastSnapshot.alternateUrls ?? [lastSnapshot.url];
		for (const url of urls) {
			if (vins[url] !== undefined) {
				auction.vin = vins[url];
			}
			if (notes[url] !== undefined) {
				auction.notes = notes[url];
			}
			auction.banned ||= bannedUrls.includes(url);
			auction.crashed ||= crashedUrls.includes(url);
			auction.fav ||= favUrls.includes(url);
			auction.dead ||= deadUrls.includes(url);
		}
	}

	function getAuctionByUrl(url) {
		return Object.values(report).find(auction => auction.snapshots.at(-1).url == url);
	}

	return report;
}

async function createHtml(report, listingDir, { bannedUrls, crashedUrls, favUrls, deadUrls }) {
	const pugger = pug.compile(await fs.readFile('report.pug'), { filename: 'pug' });
	const scale = {
		xMargin: 2,
		priceMargin: 8,
		price: 40,
		date: 150
	};

	fn.age = function(date) {
		return Math.floor(Interval.fromDateTimes(date, DateTime.now()).toDuration('days').days);
	};

	fn.priceInPln = function(price, currency) {
		return currency == 'EUR' ? Math.round(parseInt(price) * 4.2) : price;
	};

	fn.finalPriceInPln = function(price, currency) {
		return currency == 'EUR' ? Math.round(parseInt(price) * 4.2 * 1.093) : price;
	};

	fn.clamp = function(number, minimum, maximum) {
		return Math.min(Math.max(number, minimum), maximum);
	};

	return pugger( { report, bannedUrls, crashedUrls, favUrls, deadUrls, scale, fn } );
}

function createRedirectHtml(reportDir, today) {
	return `
		<!doctype html>
		<html lang=pl>
			<head>
				<meta charset=utf-8>
				<meta http-equiv="refresh" content="0; url=./${reportDir}/${today}.html">
				<title>Report</title>
			</head>
			<body>
			</body>
		</html>
	`;
}
