const REGIONS = [
	// all of conus
	{
		NAME: 'conus',
		bounds: {
			x: [-126, -65.5],
			y: [50.5, 23.5],
		},
		outputSize: {
			width: 5100,
			height: 3200,
		},
	},
	{
		NAME: 'alaska',
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
		bounds: {
			x: [-160.5, -154.5],
			y: [22.5, 18.5],
		},
		outputSize: {
			width: 506,
			height: 396,
		},
	},
];

export default REGIONS;
