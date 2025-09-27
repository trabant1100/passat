const fs = require('node:fs/promises');
const blockhash = require('blockhash-core');
const workerpool = require('workerpool');
const { imageFromBuffer, getImageData } = require('@canvas/image');

const imgFolder = './images/';

async function getFileNames() {
	return await fs.readdir(imgFolder);
}

async function generateRefMap() {
	const pool = workerpool.pool('./calcHashWorker.js');
	const files = (await getFileNames()).filter(fname => /.webp$/.test(fname));
	const refMap = new Map();
	const calcHashes = [];

	for (let i = 0; i < files.length; i++) {
		calcHashes.push(pool.exec('calcHash', [i, `${imgFolder}${files[i]}`]));
	}
	const progress = setInterval(() => {
		const { pendingTasks, activeTasks } = pool.stats();
		const progress = files.length - pendingTasks - activeTasks;
		console.log(`${progress}/${files.length}`);
	}, 1000);
	const hashes = await Promise.all(calcHashes);
	clearInterval(progress);
	pool.terminate();


	const existingHashes = JSON.parse(await fs.readFile('./images/hashes.json'));
	for (const { imgHash, filename } of hashes) {
		existingHashes[filename] = imgHash;
		let valueArray;
		if (refMap.has(imgHash)) {
			const existingPaths = refMap.get(imgHash);
			valueArray = [...existingPaths, filename];
		} else {
			valueArray = [filename];
		}
		refMap.set(imgHash, valueArray);
  	}

  	console.log('Writing ./images/hashes.json');
  	await fs.writeFile('./images/hashes.json', JSON.stringify(existingHashes, null, 4));

	return refMap;
}

async function getAuctionUrl(listingDir, auctionId) {
	const listings = (await fs.readdir(listingDir)).filter(fname => /\d\d.\d\d.\d{4}/.test(fname));
	for (const listing of listings) {
		try {
			const fullFilename = `${listingDir}/${listing}/${auctionId}.json`;
			await fs.access(fullFilename);
			const { url } = JSON.parse(await fs.readFile(fullFilename));
			return url;
		} catch(e) {

		}
	}
}

function equalSets(set1, set2) {
	if (set1.size != set2.size) {
		return false;
	}

	for (const item1 of set1) {
		if (!set2.has(item1)) {
			return false;
		}
	}

	for (const item2 of set2) {
		if (!set1.has(item2)) {
			return false;
		}
	}

	return true;
}

function intersectSets(set1, set2) {
	const res = new Set();
	for (const item1 of set1) {
		if (set2.has(item1)) {
			res.add(item1);
		}
	}

	return res;
}

function patchConfig(config, duplicates) {
	duplicates = duplicates.slice(0);
	const configDuplicates = config.report.relisted_urls;

	for (let i = duplicates.length - 1; i >= 0; i--) {
		const dup = duplicates[i];
		for (const configDup of configDuplicates) {
			if (intersectSets(new Set(dup), new Set(configDup)).size > 0) {
				console.log('Existing duplicates');
				console.log(dup);
				configDup.length = 0;
				configDup.push(...dup);
				duplicates.splice(i, 1);
			}
		}
	}

	for (const dup of duplicates) {
		console.log('Found new duplicates');
		console.log(dup);
		configDuplicates.push(dup);
	}
}

async function findDuplicateAuctions(imagesDir) {
	const files = (await getFileNames()).filter(fname => /.webp$/.test(fname));
	const auctionImages = {};

    // Group images by auction ID
    for (const file of files) {
        const [auctionId] = file.split("_");
        if (!auctionImages[auctionId]) auctionImages[auctionId] = [];
        auctionImages[auctionId].push(file);
    }

    // Generate reference map
    const refMap = await generateRefMap();

    // Reverse the mapping to group auctions by hash
    const auctionHashGroups = {};
    for (const [hash, filenames] of refMap) {
        const auctions = new Set(filenames.map(file => ((file.match(/\d+(?=_\d+.webp$)/) ?? [])[0])));
        for (const auction of auctions) {
			if (!auctionHashGroups[auction]) {
				auctionHashGroups[auction] = [];
			}
			auctionHashGroups[auction].push(hash);
			auctionHashGroups[auction].sort();
		}
    }
	for (const auction in auctionHashGroups) {
		auctionHashGroups[auction] = auctionHashGroups[auction].join(', ');
	}

    // Identify duplicate auctions
	let duplicates = {};
	for (const [auction, hash] of Object.entries(auctionHashGroups)) {
		if (!duplicates[hash]) {
			duplicates[hash] = [];
		}
		duplicates[hash].push(auction);
	}
	for (const hash in duplicates) {
		if (duplicates[hash].length < 2) {
			delete duplicates[hash];
		}
	}

	const dupArr = [];
	for (const dups of Object.values(duplicates)) {
		dupArr.push(dups);
	}

    return dupArr;
}


async function main() {
	console.log('Analyzing images');
	const config = JSON.parse(await fs.readFile('config.json'));
	const listingDir = config.listing.dir;
	let duplicates = await findDuplicateAuctions(imgFolder);

	duplicates = await Promise.all(duplicates.map(async dup => {
		return await Promise.all(dup.map(async (id) => await getAuctionUrl(listingDir, id)));
	}));
  	patchConfig(config, duplicates);

  	console.log('Writing config.json');
  	await fs.writeFile('config.json', JSON.stringify(config, null, 4));
}


if (require.main === module) {
	main();
}


module.exports = { findDuplicateAuctions };
