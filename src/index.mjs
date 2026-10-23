import drawMap from './drawmap.mjs';
import REGIONS from './REGIONS.mjs';
import MAPS from './MAPS.mjs';

// each region lists the maps it produces, alaska and hawaii only get a forecast map
const maps = await Promise.allSettled(REGIONS.flatMap((region) => region.MAPS
	.map((name) => drawMap(region, MAPS.find((map) => map.NAME === name)))));

console.log(maps);
