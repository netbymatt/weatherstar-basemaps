// Marker model for the editor: loading, edit state and the file serializers.

import createProjection from './projection.mjs';
import REGIONS from '../src/REGIONS.mjs';
import MAPS from '../src/MAPS.mjs';

const STORAGE_KEY = 'basic-map-editor-edits-v1';

export { MAPS };

// every color name any map defines, for the fill color picker
export const COLOR_NAMES = [...new Set(MAPS.flatMap((map) => Object.keys(map.COLORS ?? {})))].sort();
export const MAP_NAMES = MAPS.map((map) => map.NAME);

// lat/lon precision written to the files; 5 decimals is ~1m, well under a
// pixel of the 5100px wide map, and matches the existing station values
const LATLON_DECIMALS = 5;

const round = (value) => Number(value.toFixed(LATLON_DECIMALS));

export const region = REGIONS[0];
export const projection = createProjection(region);

const fetchJson = async (url) => {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
	return response.json();
};

// split out from createModel so editor/verify.mjs can exercise the same
// construction and serialization in node, without fetch
export const buildModel = (stationsFile, iconsFile, fillsFile = []) => {
	const items = [];

	Object.entries(stationsFile).forEach(([name, value], order) => {
		const hasLatLon = Object.hasOwn(value, 'lat') && Object.hasOwn(value, 'lon');
		items.push({
			kind: 'station',
			id: `station:${name}`,
			order,
			// as loaded from disk, used for revert and for the baked-in position
			originalName: name,
			originalLat: hasLatLon ? value.lat : null,
			originalLon: hasLatLon ? value.lon : null,
			// stations that shipped with real coordinates get flagged in the ui
			hadLatLon: hasLatLon,
			name,
			lat: hasLatLon ? value.lat : null,
			lon: hasLatLon ? value.lon : null,
			deleted: false,
		});
	});

	iconsFile.forEach((value, order) => {
		const hasLatLon = Object.hasOwn(value, 'lat') && Object.hasOwn(value, 'lon');
		items.push({
			kind: 'icon',
			id: `icon:${order}`,
			order,
			originalName: null,
			originalLat: hasLatLon ? value.lat : null,
			originalLon: hasLatLon ? value.lon : null,
			hadLatLon: hasLatLon,
			name: null,
			lat: hasLatLon ? value.lat : null,
			lon: hasLatLon ? value.lon : null,
			deleted: false,
		});
	});

	// manually marked fill points. unlike stations and road icons these have no
	// legacy pixel position; they only ever exist as lat/lon
	fillsFile.forEach((value, order) => {
		items.push({
			kind: 'fill',
			id: `fill:${order}`,
			order,
			originalName: null,
			originalLat: value.lat,
			originalLon: value.lon,
			originalColor: value.color,
			originalMaps: value.maps ? [...value.maps] : [...MAP_NAMES],
			hadLatLon: true,
			isNew: false,
			name: null,
			lat: value.lat,
			lon: value.lon,
			color: value.color,
			maps: value.maps ? [...value.maps] : [...MAP_NAMES],
			deleted: false,
		});
	});

	// where the rendered map already draws each marker
	items.forEach((item) => {
		item.bakedPosition = item.originalLat !== null
			? projection.forward([item.originalLon, item.originalLat])
			: null;
	});

	const model = {
		items,
		undoStack: [],
		dirty: false,
	};

	recomputePositions(model);
	return model;
};

export const createModel = async () => {
	const [stationsFile, iconsFile, fillsFile] = await Promise.all([
		fetchJson('/data/stations.json'),
		fetchJson('/data/road-icons.json'),
		// the fills file only exists once something has been marked
		fetchJson('/data/fills.json').catch(() => []),
	]);
	return buildModel(stationsFile, iconsFile, fillsFile);
};

// every marker is placed by its lat/lon, through the region's projection
export const positionOf = (model, item) => projection.forward([item.lon, item.lat]);

export const recomputePositions = (model) => {
	model.items.forEach((item) => {
		item.position = positionOf(model, item);
	});
};

const sameMaps = (a, b) => a.length === b.length && a.every((name) => b.includes(name));

export const isEdited = (item) => item.deleted
	|| item.isNew
	|| item.lat !== item.originalLat
	|| item.lon !== item.originalLon
	|| item.name !== item.originalName
	|| (item.kind === 'fill' && (item.color !== item.originalColor || !sameMaps(item.maps, item.originalMaps)));

export const describePlacement = (item) => (
	item.lat === item.originalLat && item.lon === item.originalLon ? 'file lat/lon' : 'corrected lat/lon'
);

/* ---------- edits ---------- */

const snapshot = (item) => ({
	id: item.id,
	lat: item.lat,
	lon: item.lon,
	name: item.name,
	deleted: item.deleted,
	// fill only
	color: item.color,
	maps: item.maps ? [...item.maps] : undefined,
	isNew: item.isNew,
});

const applySnapshot = (model, state) => {
	const item = model.items.find((candidate) => candidate.id === state.id);
	if (!item) return;
	item.lat = state.lat;
	item.lon = state.lon;
	item.name = state.name;
	item.deleted = state.deleted;
	if (item.kind === 'fill') {
		item.color = state.color;
		item.maps = state.maps ? [...state.maps] : [];
		item.isNew = state.isNew;
	}
};

// every mutation funnels through here so undo and the dirty flag stay honest
export const mutate = (model, item, changes) => {
	model.undoStack.push(snapshot(item));
	if (model.undoStack.length > 200) model.undoStack.shift();
	Object.assign(item, changes);
	model.dirty = true;
	recomputePositions(model);
};

export const moveToPixel = (model, item, px, py) => {
	const [lon, lat] = projection.inverse([px, py]);
	mutate(model, item, { lat: round(lat), lon: round(lon) });
};

export const moveToLatLon = (model, item, lat, lon) => {
	mutate(model, item, { lat: round(lat), lon: round(lon) });
};

export const revertItem = (model, item) => {
	// a fill point that was never in the file has nothing to revert to, so
	// reverting removes it instead
	if (item.kind === 'fill' && item.isNew) {
		mutate(model, item, { deleted: true });
		return;
	}
	mutate(model, item, {
		lat: item.originalLat,
		lon: item.originalLon,
		name: item.originalName,
		deleted: false,
		...(item.kind === 'fill' ? { color: item.originalColor, maps: [...item.originalMaps] } : {}),
	});
};

// add a brand new fill point at a map pixel position
export const addFill = (model, px, py, color, maps) => {
	const [lon, lat] = projection.inverse([px, py]);
	const existing = model.items.filter((item) => item.kind === 'fill');
	const order = existing.reduce((highest, item) => Math.max(highest, item.order + 1), 0);
	const item = {
		kind: 'fill',
		id: `fill:new:${Date.now()}:${order}`,
		order,
		originalName: null,
		originalLat: null,
		originalLon: null,
		originalColor: color,
		originalMaps: [...maps],
		hadLatLon: true,
		isNew: true,
		name: null,
		lat: round(lat),
		lon: round(lon),
		color,
		maps: [...maps],
		deleted: false,
	};
	// nothing was rendered for it yet, so there is no stale position to cover
	item.bakedPosition = projection.forward([item.lon, item.lat]);
	model.items.push(item);
	model.undoStack.push({ ...snapshot(item), added: true });
	model.dirty = true;
	recomputePositions(model);
	return item;
};

export const undo = (model) => {
	const state = model.undoStack.pop();
	if (!state) return false;
	// undoing the creation of a fill point drops it entirely
	if (state.added) {
		model.items = model.items.filter((item) => item.id !== state.id);
		model.dirty = true;
		recomputePositions(model);
		return true;
	}
	applySnapshot(model, state);
	model.dirty = true;
	recomputePositions(model);
	return true;
};

/* ---------- persistence ---------- */

export const saveSession = (model) => {
	const edits = model.items.filter(isEdited).map(snapshot);
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
		model.dirty = false;
		return edits.length;
	} catch {
		// private mode or a full quota; the in-memory edits still stand
		return -1;
	}
};

export const loadSession = (model) => {
	let stored;
	try {
		stored = localStorage.getItem(STORAGE_KEY);
	} catch {
		return 0;
	}
	if (!stored) return 0;

	let edits;
	try {
		edits = JSON.parse(stored);
	} catch {
		return 0;
	}

	edits.forEach((state) => {
		// a fill point added in an earlier session is not in the file yet, so
		// there is nothing on disk to apply the edit to; rebuild it instead.
		// once it has been exported and dropped into data/ it IS in the file,
		// under a different id, so match on position too or it comes back as a
		// duplicate of itself on every round trip
		const exists = model.items.some((item) => item.id === state.id
			|| (item.kind === 'fill' && item.lat === state.lat && item.lon === state.lon));
		if (!exists && state.isNew) {
			model.items.push({
				kind: 'fill',
				id: state.id,
				order: model.items.filter((item) => item.kind === 'fill').length,
				originalName: null,
				originalLat: null,
				originalLon: null,
				originalColor: state.color,
				originalMaps: state.maps ? [...state.maps] : [],
				hadLatLon: true,
				isNew: true,
				name: null,
				lat: state.lat,
				lon: state.lon,
				color: state.color,
				maps: state.maps ? [...state.maps] : [],
				deleted: state.deleted,
				bakedPosition: projection.forward([state.lon, state.lat]),
			});
			return;
		}
		applySnapshot(model, state);
	});
	recomputePositions(model);
	model.dirty = false;
	return edits.length;
};

export const clearSession = (model) => {
	try {
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		// nothing to clear
	}
	model.items = model.items.filter((item) => !item.isNew);
	model.items.forEach((item) => {
		item.lat = item.originalLat;
		item.lon = item.originalLon;
		item.name = item.originalName;
		item.deleted = false;
		if (item.kind === 'fill') {
			item.color = item.originalColor;
			item.maps = [...item.originalMaps];
		}
	});
	model.undoStack = [];
	model.dirty = false;
	recomputePositions(model);
};

/* ---------- export ---------- */

// stations.json is 2 space indented with keys in x, y, lat, lon order
export const serializeStations = (model) => {
	const output = {};
	model.items
		.filter((item) => item.kind === 'station' && !item.deleted)
		.sort((a, b) => a.order - b.order)
		.forEach((item) => {
			// written as-is: corrections are rounded when they are made, and
			// untouched values must survive byte for byte
			output[item.name] = { lat: item.lat, lon: item.lon };
		});
	return JSON.stringify(output, null, 2);
};

// fills.json follows the road-icons.json style: tab indented, one per line
export const serializeFills = (model) => {
	const lines = model.items
		.filter((item) => item.kind === 'fill' && !item.deleted)
		.sort((a, b) => a.order - b.order)
		.map((item) => {
			const maps = item.maps.map((name) => `"${name}"`).join(', ');
			return `\t{"lat": ${item.lat}, "lon": ${item.lon}, "color": "${item.color}", "maps": [${maps}]}`;
		});
	return `[\n${lines.join(',\n')}\n]`;
};

// road-icons.json is tab indented with one object per line
export const serializeIcons = (model) => {
	const lines = model.items
		.filter((item) => item.kind === 'icon' && !item.deleted)
		.sort((a, b) => a.order - b.order)
		.map((item) => `\t{"lat": ${item.lat}, "lon": ${item.lon}}`);
	return `[\n${lines.join(',\n')}\n]`;
};
