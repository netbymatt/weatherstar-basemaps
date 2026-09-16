/* eslint-disable no-plusplus */
// the section and post steps run one after another against a shared canvas, so
// they are sequential by nature: each step draws on what the previous one left,
// and the stage png is encoded from that same canvas
/* eslint-disable no-await-in-loop, no-restricted-syntax */
import { createCanvas } from 'canvas';
import { readFile } from 'node:fs/promises';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import split from './process/split.mjs';
import plot from './plot/index.mjs';
import plotFromShape from './plotfromshape/index.mjs';
import writePngToFile, { writeWebpToFile } from './utils/file.mjs';
import sliceToTiles from './utils/tiles.mjs';
import createProjection from './createProjection.mjs';
import addStations from './stations/index.mjs';
import addRoadIcons from './roadicons/index.mjs';
import addFills from './fills/index.mjs';

// get radar sites by ICAO identifier
import palettize from './palettize/index.mjs';

import readShapeFile from './readshapefile/index.mjs';

const gunzip = promisify(zlib.gunzip);

// initial data
const [states, counties, roads, land, lakes] = await Promise.all([
	readShapeFile('data/states/cb_2020_us_state_500k'),
	readShapeFile('data/counties/cb_2020_us_county_500k'),
	readFile('data/roads.json.gz').then(gunzip).then((buf) => JSON.parse(buf)),
	readShapeFile('data/land/ne_50m_land'),
	readShapeFile('data/lakes/ne_50m_lakes'),
]);

// how much the pixelated render is shrunk before being blown back up. maps can
// override it with a PIXELATE_SCALE of their own
const DEFAULT_PIXELATE_SCALE = 0.75;

// blends palettize puts between each pair of colors. the overlay tiles need the
// same number to recognize those blends
const PALETTE_STOPS = 2;

/**
 * Draw every section the map asks for onto ctx.
 *
 * This runs twice: once at full resolution, and once at the smaller pixelation
 * scale. Drawing the whole map small and blowing it up gives the rasterizer
 * the shapes at the resolution they end up at, so the result is crisply blocky
 * rather than an averaged down full resolution render. Labels and icons are
 * drawn in the same pass, scaled to match, so they need no separate treatment.
 *
 * @param {number} scale what labels, icons and markers size themselves against.
 *   Line widths are left alone: they are already at the thinnest useful width,
 *   and letting them come out chunkier is part of the low resolution look.
 * @param {Function} writeStage called after each section, to save a stage png
 */
const drawSections = async (ctx, region, map, scale, tag, writeStage) => {
	const { outputSize, bounds } = region;
	const { COLORS } = map;

	// convert bounds to bounding box format
	const bbox = {
		minX: Math.min(...bounds.x),
		maxX: Math.max(...bounds.x),
		minY: Math.min(...bounds.y),
		maxY: Math.max(...bounds.y),
	};

	// lat-lon to pixel x,y converter
	const convert = createProjection(region);

	ctx.imageSmoothingEnabled = false;

	// background
	ctx.fillStyle = COLORS.water;
	ctx.fillRect(0, 0, outputSize.width, outputSize.height);
	await writeStage();

	// call the steps in the order provided. this has to stay sequential: each
	// section draws onto the shared canvas, and the stage png is encoded from
	// that same canvas, so overlapping them would capture the wrong state
	for (const section of map.SECTIONS) {
		switch (section) {
			case 'land':
				console.time(`land-${tag}`);
				plotFromShape(ctx, convert, land, {
					strokeStyle: COLORS.land, lineWidth: 1, fillStyle: COLORS.countyFill, bbox,
				});
				console.timeEnd(`land-${tag}`);
				await writeStage();
				break;

			case 'county':
				console.time(`county-${tag}`);
				plotFromShape(ctx, convert, counties, {
					strokeStyle: COLORS.county, lineWidth: 1, fillStyle: COLORS.countyFill, bbox,
				});
				console.timeEnd(`county-${tag}`);
				await writeStage();
				break;

			case 'lakes':
				console.time(`lakes-${tag}`);
				plotFromShape(ctx, convert, lakes, {
					strokeStyle: COLORS.lakes, lineWidth: 0, fillStyle: COLORS.water, bbox,
				});
				console.timeEnd(`lakes-${tag}`);
				await writeStage();
				break;

			case 'state':
				console.time(`state-${tag}`);
				plotFromShape(ctx, convert, states, { strokeStyle: COLORS.state, fillStyle: COLORS.stateFill, lineWidth: 2 });
				console.timeEnd(`state-${tag}`);
				await writeStage();
				break;

			case 'road':
				console.time(`road-${tag}`);
				plot(ctx, convert, split(roads.elements), { strokeStyle: COLORS.road, lineWidth: 1 });
				console.timeEnd(`road-${tag}`);
				await writeStage();
				break;

			case 'fill':
				console.time(`fill-${tag}`);
				addFills(ctx, region, map);
				console.timeEnd(`fill-${tag}`);
				await writeStage();
				break;

			case 'road-icons':
				console.time(`road-icons-${tag}`);
				addRoadIcons(ctx, region, scale);
				console.timeEnd(`road-icons-${tag}`);
				await writeStage();
				break;

			case 'stations':
				console.time(`stations-${tag}`);
				addStations(ctx, region, COLORS, scale);
				console.timeEnd(`stations-${tag}`);
				await writeStage();
				break;

			default:
				console.error(`No draw method for: ${section}`);
		}
	}
};

const drawMap = async (baseRegion, map) => {
	// presence of map output size overrides region output size. build a new
	// region rather than editing the shared one, maps for the same region are
	// drawn in parallel and each needs its own size
	const region = map.outputSize ? { ...baseRegion, outputSize: map.outputSize } : baseRegion;
	const { outputSize } = region;
	const { COLORS } = map;
	const tag = `${map.NAME}-${region.NAME}`;

	console.time(`full-map-${tag}`);

	// create a canvas and context
	const canvas = createCanvas(outputSize.width, outputSize.height);
	const ctx = canvas.getContext('2d');

	let imageState = 0;
	const writeStage = async () => {
		await writePngToFile(`./output/raw/${tag}-${imageState++}.png`, ctx.canvas);
	};

	await drawSections(ctx, region, map, 1, tag, writeStage);

	await writePngToFile(`./output/raw/${tag}.png`, ctx.canvas);

	// palettized output is only produced when the map asks for it, and the
	// pixelated variant follows suit so the two stay consistent
	const palettizing = map.POST.includes('palettize');

	// the webp the tiles step slices up, set by whichever step produced it
	let tileSource = null;

	// run the post processing steps in the order provided
	for (const step of map.POST) {
		switch (step) {
			case 'palettize': {
				console.time(`palettize-${tag}`);
				const palettized = palettize(ctx, COLORS, { stops: PALETTE_STOPS });

				await writePngToFile(`./output/${tag}.png`, palettized, palettized.palette);
				tileSource = `./output/${tag}.webp`;
				await writeWebpToFile(tileSource, palettized, palettized.palette);
				console.timeEnd(`palettize-${tag}`);
				break;
			}

			// pixelate: render the whole map again at a smaller scale, then blow
			// it back up with no smoothing. drawing small means the shapes are
			// rasterized at the resolution they end up at, so the blocks come
			// out crisp instead of averaged into mush. labels and icons are
			// part of that render, scaled to match, so they need no separate
			// pixelation pass of their own
			case 'pixelate': {
				const scale = map.PIXELATE_SCALE ?? DEFAULT_PIXELATE_SCALE;
				const smallRegion = {
					...region,
					outputSize: {
						width: Math.round(outputSize.width * scale),
						height: Math.round(outputSize.height * scale),
					},
				};

				console.time(`pixelate-${tag}`);
				const smallCanvas = createCanvas(smallRegion.outputSize.width, smallRegion.outputSize.height);
				await drawSections(smallCanvas.getContext('2d'), smallRegion, map, scale, `${tag}-small`, async () => {});

				const pixelatedCanvas = createCanvas(outputSize.width, outputSize.height);
				const pixelatedCtx = pixelatedCanvas.getContext('2d');
				pixelatedCtx.imageSmoothingEnabled = false;
				pixelatedCtx.drawImage(smallCanvas, 0, 0, outputSize.width, outputSize.height);
				console.timeEnd(`pixelate-${tag}`);

				const output = palettizing ? palettize(pixelatedCtx, COLORS, { stops: PALETTE_STOPS }) : pixelatedCanvas;

				await writePngToFile(`./output/${tag}-pixelated.png`, output, output.palette);
				await writeWebpToFile(`./output/${tag}-pixelated.webp`, output, output.palette);
				break;
			}

			case 'tiles': {
				if (!tileSource) {
					console.error(`Cannot slice tiles for ${tag}: a step that writes a webp has to run first`);
					break;
				}

				// overlay colors are named by their key in COLORS
				const overlayColors = (map.OVERLAY_COLORS ?? []).filter((key) => {
					if (COLORS[key]) return true;
					console.error(`Map ${map.NAME} has no color named "${key}" for its overlay`);
					return false;
				}).map((key) => COLORS[key]);

				console.time(`tiles-${tag}`);
				await sliceToTiles(tileSource, `./output/tiles/${tag}`, 510, 320, {
					overlayColors,
					paletteColors: Object.values(COLORS),
					stops: PALETTE_STOPS,
				});
				console.timeEnd(`tiles-${tag}`);
				break;
			}

			default:
				console.error(`No post method for: ${step}`);
		}
	}

	console.timeEnd(`full-map-${tag}`);
};

export default drawMap;
