const REGIONS = [
	// all of conus
	{
		NAME: 'conus',
		// names from MAPS that get drawn for this region
		MAPS: ['radar', 'forecast'],
		bounds: {
			x: [-126, -65.5],
			y: [50.5, 23.5],
		},
		outputSize: {
			width: 5100,
			height: 3200,
		},
		// maps drawn at a size other than outputSize, by name from MAPS
		mapOutputSize: {
			forecast: {
				width: 3400,
				height: 2133,
			},
		},
	},
	{
		NAME: 'alaska',
		MAPS: ['forecast'],
		bounds: {
			x: [-170, -129],
			y: [72, 51],
		},
		outputSize: {
			width: 3456,
			height: 4276,
		},
	},
	{
		NAME: 'hawaii',
		MAPS: ['forecast'],
		bounds: {
			x: [-160.5, -154.5],
			y: [22.5, 18.5],
		},
		outputSize: {
			width: 506 * 2, // double so there's enough data to fill all screen forms
			height: 396 * 2,
		},
	},
];

export default REGIONS;
