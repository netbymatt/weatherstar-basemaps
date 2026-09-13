import proj4 from 'proj4';

// Both projections have straight, parallel meridians and parallels that meet at right angles.
// In both, x depends only on longitude and y only on latitude, so projecting two corners
// is enough to find the full extent of the bounding box.
const PROJECTIONS = {
	// Conformal: local shapes and angles are preserved, latitude spacing increases toward the poles.
	mercator: (lon0) => `+proj=merc +lon_0=${lon0} +datum=WGS84 +units=m +no_defs`,
	// Plate carrée: latitude and longitude are both linear.
	equirectangular: (lon0) => `+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=${lon0} +datum=WGS84 +units=m +no_defs`,
};

/**
 * @param {object} options
 * @param {{x: [number, number], y: [number, number]}} options.bounds
 *   x = longitude, y = latitude. x[0]/y[0] map to pixel 0, x[1]/y[1] map to width/height.
 *   e.g. { x: [-126, -65.5], y: [50.5, 23.5] } puts north at the top of the image.
 * @param {{width: number, height: number}} options.outputSize
 * @param {'mercator'|'equirectangular'} [options.projection='mercator']
 * @param {'stretch'|'contain'} [options.fit='stretch']
 *   stretch: bounds map exactly to the image edges (x and y scales can differ).
 *   contain: uniform scale, entire bounds visible and centered, extra area shown on one axis.
 * @returns {{forward: (lonLat: [number, number]) => [number, number], inverse: (pixel: [number, number]) => [number, number]}}
 */
const createProjection = ({
	bounds,
	outputSize,
	projection = 'mercator',
}) => {
	const projString = PROJECTIONS[projection];
	if (!projString) throw new Error(`Unknown projection: ${projection}`);

	const [lonA, lonB] = bounds.x;
	const [latA, latB] = bounds.y;
	const { width, height } = outputSize;

	// center the projection on the bounds (does not handle boxes crossing the antimeridian)
	const lon0 = (lonA + lonB) / 2;
	const converter = proj4('WGS84', projString(lon0));

	// projected coordinates (meters) of the corners that map to pixel [0,0] and [width,height]
	const [x0, y0] = converter.forward([lonA, latA]);
	const [x1, y1] = converter.forward([lonB, latB]);

	// signed scales, so y flips automatically when y[0] is north
	let scaleX = width / (x1 - x0);
	let scaleY = height / (y1 - y0);
	let offsetX = 0;
	let offsetY = 0;

	// grow the input (lat/lon) boundaries as needed to keep aspect ratio
	const scale = Math.min(Math.abs(scaleX), Math.abs(scaleY));
	offsetX = (width - Math.abs(x1 - x0) * scale) / 2;
	offsetY = (height - Math.abs(y1 - y0) * scale) / 2;
	scaleX = Math.sign(scaleX) * scale;
	scaleY = Math.sign(scaleY) * scale;

	// [lon, lat] -> [px, py]
	const forward = ([lon, lat]) => {
		const [x, y] = converter.forward([lon, lat]);
		return [
			(x - x0) * scaleX + offsetX,
			(y - y0) * scaleY + offsetY,
		];
	};

	// [px, py] -> [lon, lat]
	const inverse = ([px, py]) => {
		const x = (px - offsetX) / scaleX + x0;
		const y = (py - offsetY) / scaleY + y0;
		return converter.inverse([x, y]);
	};

	return { forward, inverse };
};

export default createProjection;
