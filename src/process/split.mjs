// split into ways and nodes

const split = (elements) => {
	const ways = [];
	const nodes = {};

	elements.forEach((element) => {
		if (element.type === 'way') {
			ways.push({
				id: element.id,
				nodes: element.nodes,
				tags: element.tags,
			});
		} else if (element.type === 'node') {
			nodes[element.id] = {
				lat: element.lat,
				lon: element.lon,
			};
		}
	});
	return {
		ways,
		nodes,
	};
};

export default split;
