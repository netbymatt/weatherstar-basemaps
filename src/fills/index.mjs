import { readFile } from 'node:fs/promises';
import { createCanvas } from 'canvas';
import createProjection from '../createProjection.mjs';

// manually marked points where an area needs filling in, placed with the
// editor. the file only exists once something has been marked, so a missing
// one just means there is nothing to fill
const FILLS_FILE = './data/fills.json';

const fills = await readFile(FILLS_FILE)
	.then(JSON.parse)
	.catch(() => []);

// how far a pixel may differ from the seed and still be part of the same area,
// as a distance in rgba space. big enough to absorb the antialiasing inside a
// flat region, small enough not to bleed across a drawn coastline. individual
// points can override it with a "tolerance" of their own
const DEFAULT_TOLERANCE = 32;

// colors the map draws outlines with. a seed that lands on one of these would
// flood along every connected line and erase it, which happens when a map is
// drawn small enough that an island or inlet is nothing but its outline
const LINE_COLORS = ['state', 'county', 'land', 'road', 'minorRoad'];

// parse any CSS color string to [r, g, b, a] by drawing it to a 1x1 canvas
const parseColor = (() => {
	const ctx = createCanvas(1, 1).getContext('2d');
	return (color) => {
		ctx.clearRect(0, 0, 1, 1);
		ctx.fillStyle = color;
		ctx.fillRect(0, 0, 1, 1);
		return Array.from(ctx.getImageData(0, 0, 1, 1).data);
	};
})();

/**
 * Scanline flood fill, spreading from a seed pixel across everything that
 * matches the color found there. Works on raw image data so it can run over
 * the whole map in one pass.
 * @returns {number} pixels painted
 */
const floodFill = (image, width, height, seedX, seedY, fill, tolerance) => {
	const { data } = image;
	const at = (x, y) => (y * width + x) * 4;

	const seed = at(seedX, seedY);
	const target = [data[seed], data[seed + 1], data[seed + 2], data[seed + 3]];

	const limit = tolerance * tolerance;
	const distance = (a, b) => {
		const dr = a[0] - b[0];
		const dg = a[1] - b[1];
		const db = a[2] - b[2];
		const da = a[3] - b[3];
		return dr * dr + dg * dg + db * db + da * da;
	};

	// already the right color, or so close to it that painting would never
	// stop the spread. either way there is nothing safe to do here
	if (distance(target, fill) <= limit) return 0;

	const matches = (i) => {
		const dr = data[i] - target[0];
		const dg = data[i + 1] - target[1];
		const db = data[i + 2] - target[2];
		const da = data[i + 3] - target[3];
		return dr * dr + dg * dg + db * db + da * da <= limit;
	};

	const paint = (i) => {
		[data[i], data[i + 1], data[i + 2], data[i + 3]] = fill;
	};

	let painted = 0;
	const stack = [[seedX, seedY]];

	while (stack.length > 0) {
		const [startX, y] = stack.pop();

		// walk west to the start of this run
		let x = startX;
		while (x >= 0 && matches(at(x, y))) x -= 1;
		x += 1;

		// then east, painting as we go and queueing the rows either side
		let spanAbove = false;
		let spanBelow = false;
		while (x < width && matches(at(x, y))) {
			paint(at(x, y));
			painted += 1;

			if (y > 0) {
				const above = matches(at(x, y - 1));
				if (above && !spanAbove) stack.push([x, y - 1]);
				spanAbove = above;
			}
			if (y < height - 1) {
				const below = matches(at(x, y + 1));
				if (below && !spanBelow) stack.push([x, y + 1]);
				spanBelow = below;
			}
			x += 1;
		}
	}

	return painted;
};

// a point with no maps listed applies everywhere, which keeps hand written
// entries simple
const appliesTo = (fill, map) => !fill.maps || fill.maps.includes(map.NAME);

const addFills = (ctx, region, map) => {
	const applicable = fills.filter((fill) => appliesTo(fill, map));
	if (applicable.length === 0) return;

	const toPixels = createProjection(region);
	const { width, height } = ctx.canvas;

	// one read and one write for the whole set, rather than per point
	const image = ctx.getImageData(0, 0, width, height);
	let changed = false;

	const lineColors = LINE_COLORS
		.filter((key) => map.COLORS[key])
		.map((key) => parseColor(map.COLORS[key]));

	applicable.forEach((fill) => {
		const color = map.COLORS[fill.color];
		if (!color) {
			console.error(`Map ${map.NAME} has no color named "${fill.color}" for fill at ${fill.lat}, ${fill.lon}`);
			return;
		}

		const [px, py] = toPixels.forward([fill.lon, fill.lat]);
		const x = Math.round(px);
		const y = Math.round(py);
		if (x < 0 || x >= width || y < 0 || y >= height) {
			console.error(`Fill at ${fill.lat}, ${fill.lon} falls outside ${region.NAME}`);
			return;
		}

		const tolerance = fill.tolerance ?? DEFAULT_TOLERANCE;
		const seed = (y * width + x) * 4;
		const onLine = lineColors.some((line) => line.reduce((sum, v, k) => sum + (image.data[seed + k] - v) ** 2, 0) <= tolerance * tolerance);
		if (onLine) {
			console.log(`Fill at ${fill.lat}, ${fill.lon} lands on a line in ${map.NAME}-${region.NAME}, skipping`);
			return;
		}

		const painted = floodFill(
			image,
			width,
			height,
			x,
			y,
			parseColor(color),
			tolerance,
		);
		if (painted > 0) changed = true;
	});

	if (changed) ctx.putImageData(image, 0, 0);
};

export default addFills;
