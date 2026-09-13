import drawMap from './drawmap.mjs';
import REGIONS from './REGIONS.mjs';
import MAPS from './MAPS.mjs';

const maps = await Promise.allSettled(REGIONS.map(async (region) => Promise.allSettled(MAPS.map(async (map) => drawMap(region, map)))));

console.log(maps);
