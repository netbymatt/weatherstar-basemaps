// the region as one of its maps is drawn. a region can give a map a size of
// its own in mapOutputSize, otherwise every map uses the region's outputSize.
// shared with the editor, so it has to stay browser safe
const regionForMap = (region, map) => {
	const outputSize = region.mapOutputSize?.[map.NAME];
	return outputSize ? { ...region, outputSize } : region;
};

export default regionForMap;
