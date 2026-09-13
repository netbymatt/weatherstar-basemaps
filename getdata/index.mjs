// get data from overpass api
import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import enQueue from './queue.mjs';

const gzip = promisify(zlib.gzip);

// get data for the entire continental us
const BOUNDS = {
	// [0] = top/left, [1] = bottom/right in lat/lon
	x: [-126, -65.5],
	y: [50.5, 23.5],
};

const TYPE = 'roads';

const path = './data/';
const file = `${path}${TYPE}.json.gz`;

const dataString = await enQueue(BOUNDS, TYPE);

// create local folder
try {
	await fs.mkdir(path);
} catch {
	// nothing to catch, if the folder is there already just move on
}

// store locally, compressed
const compressed = await gzip(dataString);
await fs.writeFile(file, compressed);
