import { readFile } from 'node:fs/promises';
import { loadImage } from 'canvas';
import createProjection from '../createProjection.mjs';

// road icon marker positions, each placed by its own lat/lon run through the
// region's projection
const roadIconPositions = await readFile('./data/road-icons.json').then(JSON.parse);

// resolve every marker to a lon/lat once, which does not depend on the region
const markers = roadIconPositions.map((position, index) => {
	if (!Object.hasOwn(position, 'lat') || !Object.hasOwn(position, 'lon')) {
		throw new Error(`road icon ${index} has no lat/lon; add one with the editor`);
	}
	return [position.lon, position.lat];
});

// pixel positions do depend on the region being drawn, so they are worked out
// per region and cached against it rather than once at module load
const positionsByRegion = new WeakMap();

const positionsFor = (region) => {
	const cached = positionsByRegion.get(region);
	if (cached) return cached;

	// lat-lon to pixel x,y converter for this region
	const toPixels = createProjection(region);
	const positions = markers.map((lonLat) => toPixels.forward(lonLat));
	positionsByRegion.set(region, positions);
	return positions;
};

// the road icon image, loaded once and reused for every marker
const icon = await loadImage('./reference-images/road-icon.png');

/**
 * @param {number} [scale=1] size the icon is drawn at. The pixelated map is
 *   rendered small and blown up, so its icons are drawn proportionally smaller
 *   to end up the same size as the full resolution ones.
 */
const addRoadIcons = (ctx, region, scale = 1) => {
	const width = Math.max(1, Math.round(icon.width * scale));
	const height = Math.max(1, Math.round(icon.height * scale));

	// process all the road icon markers, centering the icon on its calculated position
	positionsFor(region).forEach(([x, y]) => {
		ctx.drawImage(icon, Math.round(x - width / 2), Math.round(y - height / 2), width, height);
	});
};

export default addRoadIcons;
