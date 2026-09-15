const MAPS = [
	{
		NAME: 'radar',
		COLORS: {
			state: '#000000',
			extraFill: '#7c848a',
			county: '#31353a',
			countyFill: '#7c848a',
			minorRoad: '#339977',
			road: '#a5aeaf',
			water: '#4b69aa',
			background: '#ffffff',
			roadIconRed: '#c10415',
			roadIconBlue: '#0d1259',
		},
		// the pixelated render is drawn at this fraction of the output size,
		// then blown back up
		PIXELATE_SCALE: 0.75,
		// the tiles step also writes overlay tiles holding only pixels of
		// exactly these colors, everything else transparent. names are keys
		// into COLORS
		OVERLAY_COLORS: [
			'state',
			'county',
			'roadIconRed',
			'roadIconBlue',
		],
		SECTIONS: [
			'land',
			'county',
			'lakes',
			'state',
			'fill',
			'road',
			'road-icons',
			'stations',
		],
		POST: [
			'palettize',
			// 'pixelate',
			'tiles',
		],
	},
	{
		NAME: 'forecast',
		COLORS: {
			state: '#000000',
			stateFill: '#7f7f7f',
			extraFill: '#7f7f7f',
			water: '#4b69aa',
			background: '#ffffff',
		},
		// the pixelated render is drawn at this fraction of the output size,
		// then blown back up
		PIXELATE_SCALE: 0.75,
		SECTIONS: [
			'land',
			'state',
			'lakes',
			'fill',
		],
		POST: [
			'palettize',
			// 'pixelate',
		],
		outputSize: {
			width: 3400,
			height: 2133,
		},
	},
];

export default MAPS;
