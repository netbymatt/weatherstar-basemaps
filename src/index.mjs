import drawMap from './drawmap.mjs';
import REGIONS from './REGIONS.mjs';
import MAPS from './MAPS.mjs';

const maps = await Promise.allSettled([
	drawMap(REGIONS[0], MAPS[0]), // conus radar
	drawMap(REGIONS[0], MAPS[1]), // conus forecast
	drawMap(REGIONS[1], MAPS[1]), // alaska forecast
	drawMap(REGIONS[2], MAPS[1]), // hawaii forecast
]);

console.log(maps);
