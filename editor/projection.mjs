// Browser-side port of the rendering pipeline's coordinate math.
//
// This mirrors src/createProjection.mjs (proj4 mercator) without pulling proj4
// into the browser. editor/verify.mjs checks this file against the real
// pipeline and must be re-run if either side changes, otherwise the editor's
// preview will drift from what renders.

// WGS84 ellipsoid, matching +datum=WGS84
const A = 6378137.0;
const F = 1 / 298.257223563;
const E = Math.sqrt(2 * F - F * F);

// ellipsoidal mercator, equivalent to +proj=merc +lon_0=lon0 +datum=WGS84 +units=m
const mercator = (lon0) => {
	const lambda0 = (lon0 * Math.PI) / 180;

	const forward = ([lon, lat]) => {
		const lambda = (lon * Math.PI) / 180;
		const phi = (lat * Math.PI) / 180;
		const sinPhi = Math.sin(phi);
		const con = ((1 - E * sinPhi) / (1 + E * sinPhi)) ** (E / 2);
		return [
			A * (lambda - lambda0),
			A * Math.log(Math.tan(Math.PI / 4 + phi / 2) * con),
		];
	};

	const inverse = ([x, y]) => {
		const lambda = x / A + lambda0;
		const t = Math.exp(-y / A);
		// iterate the latitude out of the isometric latitude
		let phi = Math.PI / 2 - 2 * Math.atan(t);
		for (let i = 0; i < 12; i += 1) {
			const sinPhi = Math.sin(phi);
			const con = ((1 - E * sinPhi) / (1 + E * sinPhi)) ** (E / 2);
			const next = Math.PI / 2 - 2 * Math.atan(t * con);
			if (Math.abs(next - phi) < 1e-14) {
				phi = next;
				break;
			}
			phi = next;
		}
		return [(lambda * 180) / Math.PI, (phi * 180) / Math.PI];
	};

	return { forward, inverse };
};

/**
 * Port of src/createProjection.mjs. Only the mercator projection is supported,
 * which is the pipeline default and what the generated map uses.
 */
const createProjection = ({ bounds, outputSize }) => {
	const [lonA, lonB] = bounds.x;
	const [latA, latB] = bounds.y;
	const { width, height } = outputSize;

	const lon0 = (lonA + lonB) / 2;
	const converter = mercator(lon0);

	const [x0, y0] = converter.forward([lonA, latA]);
	const [x1, y1] = converter.forward([lonB, latB]);

	let scaleX = width / (x1 - x0);
	let scaleY = height / (y1 - y0);

	// grow the input boundaries as needed to keep aspect ratio
	const scale = Math.min(Math.abs(scaleX), Math.abs(scaleY));
	const offsetX = (width - Math.abs(x1 - x0) * scale) / 2;
	const offsetY = (height - Math.abs(y1 - y0) * scale) / 2;
	scaleX = Math.sign(scaleX) * scale;
	scaleY = Math.sign(scaleY) * scale;

	const forward = ([lon, lat]) => {
		const [x, y] = converter.forward([lon, lat]);
		return [
			(x - x0) * scaleX + offsetX,
			(y - y0) * scaleY + offsetY,
		];
	};

	const inverse = ([px, py]) => {
		const x = (px - offsetX) / scaleX + x0;
		const y = (py - offsetY) / scaleY + y0;
		return converter.inverse([x, y]);
	};

	return { forward, inverse };
};

export default createProjection;
