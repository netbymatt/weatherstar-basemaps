import fs from 'node:fs/promises';
import sharp from 'sharp';
import { parseColor, blend } from '../palettize/index.mjs';

// lossless, maximum-effort webp for every tile
const WEBP_OPTIONS = { lossless: true, effort: 6 };

// pack rgb into one number so each pixel is a single map lookup
const rgbKey = (r, g, b) => (r << 16) | (g << 8) | b;

/**
 * Work out which source pixels survive into the overlay, and what they become.
 * Each overlay color is kept as is, and the palette stop one step from it
 * toward every other palette color (the antialiased edge palettize leaves
 * behind) is kept as the overlay color, one stop closer to transparent.
 * @param {string[]} overlayColors CSS colors to keep
 * @param {string[]} paletteColors every color the source was palettized with
 * @param {number} stops blends palettize put between each pair of colors
 * @returns {Map<number, number[]>} rgbKey of a source pixel to the [r, g, b, a] written
 */
const buildOverlayLookup = (overlayColors, paletteColors, stops) => {
	const lookup = new Map();
	const overlay = overlayColors.map(parseColor);
	const palette = paletteColors.map(parseColor);
	const step = 1 / (stops + 1);

	// exact colors first, so a stop that lands on another overlay color never replaces it
	overlay.forEach((color) => lookup.set(rgbKey(...color), color));

	overlay.forEach((color) => {
		const faded = [color[0], color[1], color[2], Math.round(color[3] * (1 - step))];
		palette.forEach((other) => {
			const [r, g, b] = blend(color, other, step);
			const key = rgbKey(r, g, b);
			if (!lookup.has(key)) lookup.set(key, faded);
		});
	});

	return lookup;
};

// cut raw rgba pixels into tileWidth x tileHeight tiles, written as
// {outputDir}/{xx}-{yy}.webp where xx is the column (west to east) and yy is
// the row (north to south), both zero-padded to 2 digits
const writeTiles = async (pixels, raw, outputDir, tileWidth, tileHeight) => {
	await fs.mkdir(outputDir, { recursive: true });

	const { width, height } = raw;
	const columns = Math.ceil(width / tileWidth);
	const rows = Math.ceil(height / tileHeight);

	const jobs = [];
	for (let x = 0; x < columns; x += 1) {
		for (let y = 0; y < rows; y += 1) {
			const left = x * tileWidth;
			const top = y * tileHeight;
			const extractWidth = Math.min(tileWidth, width - left);
			const extractHeight = Math.min(tileHeight, height - top);

			const xx = String(x).padStart(2, '0');
			const yy = String(y).padStart(2, '0');

			jobs.push(
				sharp(pixels, { raw })
					.extract({
						left, top, width: extractWidth, height: extractHeight,
					})
					.webp(WEBP_OPTIONS)
					.toFile(`${outputDir}/${xx}-${yy}.webp`),
			);
		}
	}

	await Promise.all(jobs);
};

// slice a palettized image into tiles twice:
//   {outputDir}/base    the image as is
//   {outputDir}/overlay only the overlay colors and their one-stop edges (see
//                       buildOverlayLookup), everything else transparent
// the overlay is skipped when no overlay colors are provided
const sliceToTiles = async (source, outputDir, tileWidth, tileHeight, {
	overlayColors = [], paletteColors = [], stops = 0,
} = {}) => {
	// decode once, both sets are cut from the same pixels
	const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	const raw = { width: info.width, height: info.height, channels: 4 };

	await writeTiles(data, raw, `${outputDir}/base`, tileWidth, tileHeight);

	if (overlayColors.length === 0) return;

	const lookup = buildOverlayLookup(overlayColors, paletteColors, stops);

	const overlay = Buffer.from(data);
	for (let i = 0; i < overlay.length; i += 4) {
		const replacement = overlay[i + 3] === 0 ? undefined : lookup.get(rgbKey(overlay[i], overlay[i + 1], overlay[i + 2]));
		if (replacement) {
			overlay.set(replacement, i);
		} else {
			// clear rgb as well as alpha so the transparent area compresses to nothing
			overlay.fill(0, i, i + 4);
		}
	}

	await writeTiles(overlay, raw, `${outputDir}/overlay`, tileWidth, tileHeight);
};

export default sliceToTiles;
