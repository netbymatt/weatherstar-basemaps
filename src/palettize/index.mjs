import { createCanvas } from 'canvas';

const MAX_PALETTE = 256;

// parse any CSS color string to [r, g, b, a] (0-255) by drawing it to a 1x1 canvas
const parseColor = (() => {
	const ctx = createCanvas(1, 1).getContext('2d');
	return (color) => {
		// invalid colors are silently ignored by fillStyle, detect that with two sentinels
		ctx.fillStyle = '#f00';
		ctx.fillStyle = color;
		const first = ctx.fillStyle;
		ctx.fillStyle = '#00f';
		ctx.fillStyle = color;
		if (first !== ctx.fillStyle) throw new Error(`Invalid color: ${color}`);

		ctx.clearRect(0, 0, 1, 1);
		ctx.fillRect(0, 0, 1, 1);
		return Array.from(ctx.getImageData(0, 0, 1, 1).data);
	};
})();

// canvas antialiasing blends in premultiplied space, so interpolate and match there
const premultiply = ([r, g, b, a]) => [(r * a) / 255, (g * a) / 255, (b * a) / 255, a];

const unpremultiply = ([r, g, b, a]) => {
	if (a === 0) return [0, 0, 0, 0];
	const scale = 255 / a;
	return [r * scale, g * scale, b * scale, a].map((v) => Math.min(255, Math.max(0, Math.round(v))));
};

// provided colors first (in object order), then `stops` blends between every pair
const buildPalette = (colorValues, stops) => {
	const entries = [];
	const seen = new Set();
	const add = (rgba) => {
		const key = rgba.join();
		if (seen.has(key)) return;
		seen.add(key);
		entries.push(rgba);
	};

	const base = colorValues.map(parseColor);
	base.forEach(add);

	for (let i = 0; i < base.length; i += 1) {
		for (let j = i + 1; j < base.length; j += 1) {
			const from = premultiply(base[i]);
			const to = premultiply(base[j]);
			for (let s = 1; s <= stops; s += 1) {
				const t = s / (stops + 1);
				add(unpremultiply(from.map((v, k) => v + (to[k] - v) * t)));
			}
		}
	}

	if (entries.length > MAX_PALETTE) {
		throw new Error(`Palette has ${entries.length} entries, maximum is ${MAX_PALETTE}`);
	}
	return entries;
};

/**
 * Convert an RGBA canvas to an 8-bit indexed canvas.
 * @param {CanvasRenderingContext2D} sourceCtx node-canvas 2d context (default RGBA32 format)
 * @param {Object<string, string>} colors values are CSS colors used in the source image
 * @param {object} [options]
 * @param {number} [options.stops=4] interpolated colors between each pair of colors
 * @returns {Canvas} A8 canvas with `palette` (Uint8ClampedArray) and `paletteIndex` ({key: index}) attached.
 *   Encode with: canvas.toBuffer('image/png', { palette: canvas.palette })
 */
const palettize = (sourceCtx, colors, { stops = 4 } = {}) => {
	const { width, height } = sourceCtx.canvas;
	const keys = Object.keys(colors);
	const palette = buildPalette(Object.values(colors), stops);
	const premultipliedPalette = palette.map(premultiply);

	const nearest = (rgba) => {
		const [r, g, b, a] = premultiply(rgba);
		let best = 0;
		let bestDistance = Infinity;
		premultipliedPalette.forEach(([pr, pg, pb, pa], index) => {
			const distance = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2 + (a - pa) ** 2;
			if (distance < bestDistance) {
				bestDistance = distance;
				best = index;
			}
		});
		return best;
	};

	const src = sourceCtx.getImageData(0, 0, width, height).data;

	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext('2d', { pixelFormat: 'A8' });
	// getImageData on an A8 context returns exactly width * height bytes
	// (createImageData over-allocates to the row stride, which putImageData ignores)
	const out = ctx.getImageData(0, 0, width, height);
	const dst = out.data;

	// cache lookups by source color, runs of identical pixels skip the cache entirely
	const cache = new Map();
	let lastKey = -1;
	let lastIndex = 0;
	const pixelCount = width * height;

	for (let p = 0, i = 0; p < pixelCount; p += 1, i += 4) {
		const a = src[i + 3];
		// all fully transparent pixels share a key regardless of rgb
		const key = a === 0 ? 0 : (src[i] * 16777216) + (src[i + 1] << 16) + (src[i + 2] << 8) + a;
		if (key !== lastKey) {
			let index = cache.get(key);
			if (index === undefined) {
				index = a === 0 ? nearest([0, 0, 0, 0]) : nearest([src[i], src[i + 1], src[i + 2], a]);
				cache.set(key, index);
			}
			lastKey = key;
			lastIndex = index;
		}
		dst[p] = lastIndex;
	}

	ctx.putImageData(out, 0, 0);

	canvas.palette = new Uint8ClampedArray(palette.flat());
	// provided colors are the first entries, but duplicates were collapsed, so look them up
	const baseKeys = palette.map((rgba) => rgba.join());
	canvas.paletteIndex = Object.fromEntries(keys.map((key) => [key, baseKeys.indexOf(parseColor(colors[key]).join())]));

	return canvas;
};

export default palettize;
