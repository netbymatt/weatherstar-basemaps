// Checks the editor against the real rendering pipeline:
//   - editor/projection.mjs reproduces proj4's results
//   - the exporters round trip data/*.json byte for byte
//
// Run this after touching either side:
//   npm run editor:verify

import { readFile } from 'node:fs/promises';
import realCreateProjection from '../src/createProjection.mjs';
import REGIONS from '../src/REGIONS.mjs';
import createProjection from './projection.mjs';
import { buildModel, serializeStations, serializeIcons } from './data.mjs';

const tile = REGIONS[0];
const real = realCreateProjection(tile);
const port = createProjection(tile);

let maxForward = 0;
let maxInverse = 0;
let maxRoundTrip = 0;

// sweep the whole output image, well past the bounds of the data
const { width, height } = tile.outputSize;
for (let px = 0; px <= width; px += 25) {
	for (let py = 0; py <= height; py += 25) {
		const realLonLat = real.inverse([px, py]);
		const portLonLat = port.inverse([px, py]);
		maxInverse = Math.max(
			maxInverse,
			Math.abs(realLonLat[0] - portLonLat[0]),
			Math.abs(realLonLat[1] - portLonLat[1]),
		);

		const realPixel = real.forward(realLonLat);
		const portPixel = port.forward(realLonLat);
		maxForward = Math.max(
			maxForward,
			Math.abs(realPixel[0] - portPixel[0]),
			Math.abs(realPixel[1] - portPixel[1]),
		);

		// the editor relies on inverse then forward landing back on the click
		const back = port.forward(portLonLat);
		maxRoundTrip = Math.max(maxRoundTrip, Math.abs(back[0] - px), Math.abs(back[1] - py));
	}
}

const results = [
	['projection forward (pixels)', maxForward, 1e-6],
	['projection inverse (degrees)', maxInverse, 1e-9],
	['projection round trip (pixels)', maxRoundTrip, 1e-6],
];

let failed = false;
results.forEach(([label, value, tolerance]) => {
	const ok = value <= tolerance;
	if (!ok) failed = true;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(32)} max diff ${value.toExponential(3)} (tolerance ${tolerance.toExponential(0)})`);
});

// an export with no corrections has to preserve every value, so that
// corrections are the only meaningful lines in the resulting diff
const stationsText = await readFile('./data/stations.json', 'utf8');
const iconsText = await readFile('./data/road-icons.json', 'utf8');
const model = buildModel(JSON.parse(stationsText), JSON.parse(iconsText));

const stationsExport = serializeStations(model);
const iconsExport = serializeIcons(model);

console.log('');

// data is identical, including key order and number precision
const checkData = (label, actual, expected) => {
	const same = JSON.stringify(JSON.parse(actual)) === JSON.stringify(expected);
	if (!same) {
		failed = true;
		console.log(`FAIL  ${label.padEnd(32)} values or key order changed`);
		return;
	}
	console.log(`PASS  ${label.padEnd(32)} values and key order preserved`);
};

checkData('stations.json data', stationsExport, JSON.parse(stationsText));
checkData('road-icons.json data', iconsExport, JSON.parse(iconsText));

// formatting matches the repo style. stations.json has one hand-edited,
// tab-indented entry that the export normalizes to the file's usual 2 space
// style, so it is compared against the canonical form rather than raw bytes.
const checkFormat = (label, actual, expected, note = '') => {
	if (actual !== expected) {
		failed = true;
		const at = [...actual].findIndex((char, index) => char !== expected[index]);
		console.log(`FAIL  ${label.padEnd(32)} differs at offset ${at}`);
		console.log(`        expected ${JSON.stringify(expected.slice(Math.max(0, at - 30), at + 30))}`);
		console.log(`        actual   ${JSON.stringify(actual.slice(Math.max(0, at - 30), at + 30))}`);
		return;
	}
	console.log(`PASS  ${label.padEnd(32)} ${actual.length} bytes${note}`);
};

checkFormat('stations.json format', stationsExport, JSON.stringify(JSON.parse(stationsText), null, 2), ', canonical 2 space');
checkFormat('road-icons.json format', iconsExport, iconsText, ' identical to disk');

if (failed) {
	console.error('\neditor does not match the pipeline');
	process.exit(1);
}
console.log('\neditor matches the pipeline');
