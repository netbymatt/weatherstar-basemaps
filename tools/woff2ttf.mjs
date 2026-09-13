// WOFF -> TTF.
//
// node-canvas draws through FreeType, which reads sfnt files (ttf/otf) but not
// the WOFF wrapper. A woff passed to registerFont is accepted without error and
// then draws .notdef boxes, and even measureText returns plausible widths, so
// the problem only shows up in the rendered pixels.
//
// WOFF is a TrueType file whose tables are individually zlib-compressed inside
// a different header, so unwrapping it is lossless.
//
//   node tools/woff2ttf.mjs "fonts/Star4000.woff" "fonts/Star4000.ttf"
//
// Only WOFF 1 is handled; WOFF 2 uses brotli and a different table format.
/* eslint-disable n/no-sync */
// a one shot build tool: the sync inflate keeps the table walk readable
import { readFile, writeFile } from 'node:fs/promises';
import zlib from 'node:zlib';

const [input, output] = process.argv.slice(2);
const woff = await readFile(input);

if (woff.readUInt32BE(0) !== 0x774f4646) throw new Error('not a WOFF file (bad signature)');

const flavor = woff.readUInt32BE(4);
const numTables = woff.readUInt16BE(12);

// read the WOFF table directory
const entries = [];
for (let i = 0; i < numTables; i += 1) {
	const at = 44 + i * 20;
	entries.push({
		tag: woff.subarray(at, at + 4),
		offset: woff.readUInt32BE(at + 4),
		compLength: woff.readUInt32BE(at + 8),
		origLength: woff.readUInt32BE(at + 12),
		origChecksum: woff.readUInt32BE(at + 16),
	});
}

// decompress each table; a table is stored raw when its lengths match
const tables = entries.map((entry) => {
	const raw = woff.subarray(entry.offset, entry.offset + entry.compLength);
	const data = entry.compLength === entry.origLength ? raw : zlib.inflateSync(raw);
	if (data.length !== entry.origLength) throw new Error(`table ${entry.tag} wrong length after inflate`);
	return { ...entry, data };
});

// rebuild the sfnt: header, directory, then 4 byte aligned table data
const searchRange = 2 ** Math.floor(Math.log2(numTables)) * 16;
const header = Buffer.alloc(12);
header.writeUInt32BE(flavor, 0);
header.writeUInt16BE(numTables, 4);
header.writeUInt16BE(searchRange, 6);
header.writeUInt16BE(Math.floor(Math.log2(numTables)), 8);
header.writeUInt16BE(numTables * 16 - searchRange, 10);

const directory = Buffer.alloc(numTables * 16);
let offset = 12 + numTables * 16;
const body = [];

tables.forEach((table, i) => {
	table.tag.copy(directory, i * 16);
	directory.writeUInt32BE(table.origChecksum, i * 16 + 4);
	directory.writeUInt32BE(offset, i * 16 + 8);
	directory.writeUInt32BE(table.origLength, i * 16 + 12);

	body.push(table.data);
	offset += table.data.length;
	const padding = (4 - (table.data.length % 4)) % 4;
	if (padding) {
		body.push(Buffer.alloc(padding));
		offset += padding;
	}
});

await writeFile(output, Buffer.concat([header, directory, ...body]));
console.log(`${input} -> ${output}  (${numTables} tables, ${offset} bytes)`);
