// plot a series of ways and nodes

const bboxIntersects = (featureBBox, viewBBox) => !(featureBBox.maxX < viewBBox.minX
           || featureBBox.minX > viewBBox.maxX
           || featureBBox.maxY < viewBBox.minY
           || featureBBox.minY > viewBBox.maxY);

const getBbox = (pairs) => pairs.reduce((prev, [x, y]) => ({
	minX: Math.min(x, prev.minX ?? Infinity),
	maxX: Math.max(x, prev.maxX ?? -Infinity),
	minY: Math.min(y, prev.minY ?? Infinity),
	maxY: Math.max(y, prev.maxY ?? -Infinity),
}), {});

// default options
const defaultOptions = {
	strokeStyle: '#ffffff',
	lineWidth: 1,
};

const plotFromShape = (ctx, convert, data, _options) => {
	const options = {
		...defaultOptions,
		..._options,
	};

	// loop through each group
	data.forEach((group, i) => {
		let firstPair = true;
		// check the bounding box if provided
		if (options.bbox) {
			if (!bboxIntersects(getBbox(group), options.bbox)) return;
		}
		group.forEach((pair) => {
			const pos = convert.forward(pair);
			const posOk = !(Number.isNaN(pos[0]) || Number.isNaN(pos[1]));
			if (!firstPair && posOk) {
				ctx.lineTo(...pos);
			}
			if (firstPair && posOk) {
				ctx.beginPath();
				ctx.strokeStyle = options.strokeStyle;
				ctx.lineWidth = options.lineWidth;
				ctx.moveTo(...pos);
				firstPair = false;
			}
		});
		if (options.fillStyle) {
			ctx.fillStyle = options.fillStyle;
			ctx.fill();
		}
		ctx.closePath();
		ctx.stroke();
	});
	return ctx;
};

export default plotFromShape;
