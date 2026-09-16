import { readFile } from 'node:fs/promises';
import { registerFont } from 'canvas';
import createProjection from '../createProjection.mjs';

// node-canvas goes through FreeType, which reads sfnt files (ttf/otf) but not
// the woff wrapper - a woff registers without error and then draws .notdef
// boxes. the ttf is the same font unwrapped, via tools/woff2ttf.mjs.
registerFont('./fonts/Star4000.ttf', { family: 'Star4000' });

// read the stations file. every station is placed by its own lat/lon, run
// through the region's projection
const stations = await readFile('./data/stations.json').then(JSON.parse);

// pixel positions depend on the region being drawn, so they are worked out
// per region and cached against it rather than once at module load
const positionsByRegion = new WeakMap();

const positionsFor = (region) => {
	const cached = positionsByRegion.get(region);
	if (cached) return cached;

	// lat-lon to pixel x,y converter for this region
	const toPixels = createProjection(region);
	const positions = Object.entries(stations).map(([name, pos]) => {
		if (pos.lat === undefined || pos.lon === undefined) {
			throw new Error(`station ${name} has no lat/lon; add one with the editor`);
		}
		const [x, y] = toPixels.forward([pos.lon, pos.lat]);
		return { name, x, y };
	});
	positionsByRegion.set(region, positions);
	return positions;
};

// the full size label. the pixelated variant renders the same thing at half
// this and doubles it, so both come from one definition
const FONT_SIZE = 18;
const STROKE_WIDTH = 4;
// the text sits this far above the station's true position
const TEXT_RISE = 12;
// the drop shadow sits this far right of and below the label
const SHADOW_OFFSET = 1;

// no bold: the family has one weight, and asking for bold makes the renderer
// synthesize it, which smears a pixel font
const fontAt = (size) => `${size}px "Star4000"`;

// draw a label's text centered on x with its middle at y. scale 1 is the full
// size label; 0.5 rasterizes the glyphs at half size for the pixelated variant
const drawLabelText = (ctx, name, x, y, colors, scale = 1) => {
	// some names are duplicates an end in -2
	// this allows the non-dupe keys in json without plotting the extra 2 on the map
	const shortName = name.substring(0, 3);
	ctx.font = fontAt(FONT_SIZE * scale);
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.lineJoin = 'round';
	ctx.lineWidth = STROKE_WIDTH * scale;

	// drop shadow first, the whole label offset down and right, so the label
	// proper covers all of it but the offset edge
	if (colors.stationShadow) {
		const offset = SHADOW_OFFSET * scale;
		ctx.strokeStyle = colors.stationShadow;
		ctx.fillStyle = colors.stationShadow;
		ctx.strokeText(shortName, x + offset, y + offset);
		ctx.fillText(shortName, x + offset, y + offset);
	}

	// black outline next, so the white fill sits on top
	ctx.strokeStyle = '#000';
	ctx.strokeText(shortName, x, y);

	ctx.fillStyle = '#dcdedd';
	ctx.fillText(shortName, x, y);
};

// small marker rectangle sitting on the station's true position, kept on whole
// pixels so it stays sharp
const drawMarkerRect = (ctx, x, y, scale = 1) => {
	const width = Math.max(1, Math.round(4 * scale));
	const height = Math.max(1, Math.round(3 * scale));
	ctx.fillStyle = '#b5bdc4';
	ctx.fillRect(Math.round(x - 2 * scale), Math.round(y - 1 * scale), width, height);
};

/**
 * @param {Object<string, string>} colors the map's COLORS
 * @param {number} [scale=1] size the label is drawn at. The pixelated map is
 *   rendered small and blown up, so its labels are drawn proportionally
 *   smaller to end up the same size as the full resolution ones.
 */
const addStations = (ctx, region, colors, scale = 1) => {
	// process all the stations
	positionsFor(region).forEach(({ name, x, y }) => {
		// deliberate shift upwards to account for center-of-text rendering
		drawLabelText(ctx, name, x, y - TEXT_RISE * scale, colors, scale);
		drawMarkerRect(ctx, x, y, scale);
	});
};

export default addStations;
