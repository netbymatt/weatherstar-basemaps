// plot a series of ways and nodes

// default options
const defaultOptions = {
	strokeStyle: '#ffffff',
	lineWidth: 1,
};

const plot = (ctx, convert, data, _options) => {
	const { ways, nodes } = data;
	const options = {
		...defaultOptions,
		..._options,
	};

	// loop through each way
	ways.forEach((way, i) => {
		let firstNode = true;
		// loop thorugh each node
		way.nodes.forEach((nodeId) => {
			const node = nodes[nodeId];
			const pos = convert.forward([node.lon, node.lat]);
			if (firstNode) {
				ctx.beginPath();
				ctx.strokeStyle = options.strokeStyle;
				ctx.lineWidth = options.lineWidth;
				ctx.moveTo(...pos);
				firstNode = false;
			} else {
				ctx.lineTo(...pos);
			}
		});
		ctx.stroke();
	});
	return ctx;
};

export default plot;
