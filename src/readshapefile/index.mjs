import shapefile from 'shapefile';

const unpack = (array, dest) => {
	if (typeof array?.[0]?.[0] === 'number') {
		dest.push(array);
	} else {
		array.forEach((smallerArray) => unpack(smallerArray, dest));
	}
};

const readShapeFile = async (fileName) => {
	const states = [];
	const file = await shapefile.open(fileName);
	let done = false;
	while (!done) {
		const data = await file.read();
		if (!data.done) {
			const newData = [];
			unpack(data.value.geometry.coordinates, newData);
			states.push(...newData);
		}
		done = data.done;
	}
	return states;
};

export default readShapeFile;
