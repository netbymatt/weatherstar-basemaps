// Marker editor: viewport rendering and interaction.

import {
	region,
	createModel,
	recomputePositions,
	isEdited,
	describePlacement,
	mutate,
	moveToPixel,
	moveToLatLon,
	revertItem,
	undo,
	saveSession,
	loadSession,
	clearSession,
	serializeStations,
	serializeIcons,
	serializeFills,
	projection,
	addFill,
	COLOR_NAMES,
	MAP_NAMES,
} from './data.mjs';

const MAP_WIDTH = region.outputSize.width;
const MAP_HEIGHT = region.outputSize.height;

// how close (in screen pixels) the cursor must be to count as hitting a marker
const HIT_RADIUS = 14;
// pointer travel that turns a click into a pan
const DRAG_THRESHOLD = 3;
const LABEL_FONT = 'bold 18px "Arial Narrow", "Liberation Sans Narrow", Arial, sans-serif';

const $ = (id) => document.getElementById(id);

const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const measureCtx = document.createElement('canvas').getContext('2d');
measureCtx.font = LABEL_FONT;

const view = { scale: 1, tx: 0, ty: 0 };
const layers = { reference: null, generated: null, icon: null };

const REF_OFFSET_KEY = 'basic-map-editor-reference-offset-v1';

const ui = {
	mode: 'markers',
	// which rendered map is shown as the generated layer
	generatedMap: MAP_NAMES[0],
	fillColor: 'stateFill',
	fillMaps: [...MAP_NAMES],
	layer: 'generated',
	blend: 1,
	showIcons: true,
	showStations: true,
	hideOverlays: false,
	// shifts the reference image only, so the two projections can be lined up
	// by eye; never affects marker positions or exported data
	refOffset: { x: 0, y: 0 },
};

// true while the peek key is held, showing whichever layer is not on top
let peeking = false;

let model = null;
let selected = null;
let hovered = null;

/* ---------- coordinate helpers ---------- */

const toScreen = (wx, wy) => [wx * view.scale + view.tx, wy * view.scale + view.ty];
const toWorld = (sx, sy) => [(sx - view.tx) / view.scale, (sy - view.ty) / view.scale];

// world space footprint of a marker, sized to cover what the renderer drew.
// padded a little so the red cover hides the outline stroke and its
// antialiasing halo, not just the glyphs
const footprintOf = (item) => {
	if (item.kind === 'icon') {
		return {
			width: 17, height: 16, offsetX: -8.5, offsetY: -8,
		};
	}
	// station labels sit 8px above the anchor, with the position dot on it
	const width = measureCtx.measureText(item.name ?? '').width + 14;
	return {
		width, height: 28, offsetX: -width / 2, offsetY: -22,
	};
};

/* ---------- view ---------- */

const resize = () => {
	const dpr = window.devicePixelRatio || 1;
	const { clientWidth, clientHeight } = canvas;
	canvas.width = Math.round(clientWidth * dpr);
	canvas.height = Math.round(clientHeight * dpr);
	render();
};

const fitToWindow = () => {
	const scale = Math.min(canvas.clientWidth / MAP_WIDTH, canvas.clientHeight / MAP_HEIGHT);
	view.scale = scale;
	view.tx = (canvas.clientWidth - MAP_WIDTH * scale) / 2;
	view.ty = (canvas.clientHeight - MAP_HEIGHT * scale) / 2;
	render();
};

const zoomAt = (screenX, screenY, factor) => {
	const next = Math.min(16, Math.max(0.02, view.scale * factor));
	const applied = next / view.scale;
	view.tx = screenX - (screenX - view.tx) * applied;
	view.ty = screenY - (screenY - view.ty) * applied;
	view.scale = next;
	render();
};

/* ---------- drawing ---------- */

// which layer is drawn on top right now, accounting for the peek key
const topLayer = () => {
	if (!peeking) return ui.layer;
	return ui.layer === 'generated' ? 'reference' : 'generated';
};

const drawBaseLayers = () => {
	const onTop = topLayer();
	const order = onTop === 'generated'
		? [['reference', layers.reference], ['generated', layers.generated]]
		: [['generated', layers.generated], ['reference', layers.reference]];

	ctx.save();
	ctx.translate(view.tx, view.ty);
	ctx.scale(view.scale, view.scale);
	// keep pixels crisp once zoomed past 1:1, smooth when shrunk
	ctx.imageSmoothingEnabled = view.scale < 1;

	const bottomExists = Boolean(order[0][1]);
	order.forEach(([name, image], index) => {
		if (!image) return;
		// only the reference image carries the alignment offset
		const dx = name === 'reference' ? ui.refOffset.x : 0;
		const dy = name === 'reference' ? ui.refOffset.y : 0;
		ctx.globalAlpha = index === 1 && bottomExists ? ui.blend : 1;
		ctx.drawImage(image, dx, dy, MAP_WIDTH, MAP_HEIGHT);
	});
	ctx.globalAlpha = 1;

	ctx.restore();
};

// world rect -> screen rect
const screenRect = (item, footprint, position) => {
	const [sx, sy] = toScreen(position[0] + footprint.offsetX, position[1] + footprint.offsetY);
	return [sx, sy, footprint.width * view.scale, footprint.height * view.scale];
};

const strokeRect = (rect, color, lineWidth = 1) => {
	ctx.strokeStyle = color;
	ctx.lineWidth = lineWidth;
	// a marker can shrink below a pixel when zoomed out; keep it visible
	ctx.strokeRect(rect[0], rect[1], Math.max(rect[2], 3), Math.max(rect[3], 3));
};

// a fill point: a green crosshair marking where the render-time flood fill
// starts from. the fill itself is not previewed here
const drawFill = (item) => {
	const [sx, sy] = toScreen(item.position[0], item.position[1]);
	if (item.deleted) return;

	const active = item === selected;
	const arm = active ? 16 : 11;

	ctx.strokeStyle = '#38c172';
	ctx.lineWidth = active ? 2.5 : 1.75;
	ctx.beginPath();
	ctx.moveTo(sx - arm, sy);
	ctx.lineTo(sx + arm, sy);
	ctx.moveTo(sx, sy - arm);
	ctx.lineTo(sx, sy + arm);
	ctx.stroke();
	ctx.beginPath();
	ctx.arc(sx, sy, arm * 0.45, 0, Math.PI * 2);
	ctx.stroke();
};

const drawMarker = (item) => {
	const [sx, sy] = toScreen(item.position[0], item.position[1]);
	if (sx < -80 || sy < -80 || sx > canvas.clientWidth + 80 || sy > canvas.clientHeight + 80) return;

	const footprint = footprintOf(item);
	const edited = isEdited(item);

	// the stale marker still baked into the generated image
	if (edited) {
		const bakedRect = screenRect(item, footprint, item.bakedPosition);
		ctx.fillStyle = 'rgba(214, 44, 39, 0.97)';
		ctx.fillRect(bakedRect[0], bakedRect[1], Math.max(bakedRect[2], 3), Math.max(bakedRect[3], 3));
		strokeRect(bakedRect, '#ff6b66', 1);
	}

	if (item.deleted) return;

	const rect = screenRect(item, footprint, item.position);

	if (edited) {
		// the corrected location, previewing what the next render will draw
		ctx.fillStyle = 'rgba(56, 193, 114, 0.5)';
		ctx.fillRect(rect[0], rect[1], Math.max(rect[2], 3), Math.max(rect[3], 3));
		strokeRect(rect, '#38c172', 1.5);
		if (item.kind === 'icon' && layers.icon && view.scale > 0.4) {
			ctx.drawImage(layers.icon, rect[0], rect[1], rect[2], rect[3]);
		} else if (item.kind === 'station' && view.scale > 0.35) {
			ctx.save();
			ctx.font = `bold ${18 * view.scale}px "Arial Narrow", "Liberation Sans Narrow", Arial, sans-serif`;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.lineWidth = 4 * view.scale;
			ctx.strokeStyle = '#000';
			ctx.strokeText(item.name, sx, sy - 8 * view.scale);
			ctx.fillStyle = '#dcdedd';
			ctx.fillText(item.name, sx, sy - 8 * view.scale);
			ctx.restore();
		}
	} else if (item.kind === 'icon') {
		if (ui.showIcons) strokeRect(rect, 'rgba(240, 161, 50, 0.85)', 1);
	} else if (item.hadLatLon) {
		// stations that shipped with real coordinates, flagged for extra care
		strokeRect(rect, 'rgba(47, 111, 208, 0.9)', 1);
	} else {
		strokeRect(rect, 'rgba(190, 200, 210, 0.5)', 1);
	}

	if (item === hovered || item === selected) {
		const color = item === selected ? '#4aa3ff' : 'rgba(255, 255, 255, 0.65)';
		ctx.beginPath();
		ctx.arc(sx, sy, HIT_RADIUS, 0, Math.PI * 2);
		ctx.strokeStyle = color;
		ctx.lineWidth = item === selected ? 2 : 1;
		ctx.stroke();

		if (item === selected) {
			ctx.beginPath();
			ctx.moveTo(sx - HIT_RADIUS - 8, sy);
			ctx.lineTo(sx + HIT_RADIUS + 8, sy);
			ctx.moveTo(sx, sy - HIT_RADIUS - 8);
			ctx.lineTo(sx, sy + HIT_RADIUS + 8);
			ctx.stroke();
		}

		const label = item.kind === 'station' ? item.name : `icon ${item.order}`;
		ctx.font = '11px ui-monospace, Menlo, monospace';
		const width = ctx.measureText(label).width + 10;
		ctx.fillStyle = 'rgba(12, 15, 18, 0.9)';
		ctx.fillRect(sx + 16, sy - 22, width, 17);
		ctx.fillStyle = '#dfe4e8';
		ctx.fillText(label, sx + 21, sy - 10);
	}
};

const render = () => {
	if (!ctx) return;
	const dpr = window.devicePixelRatio || 1;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
	ctx.fillStyle = '#0e1114';
	ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);

	drawBaseLayers();

	if (!model) return;
	if (!ui.hideOverlays) {
		// in fill mode the markers dim back so the crosshairs stand out
		ctx.globalAlpha = ui.mode === 'fill' ? 0.28 : 1;
		model.items.forEach((item) => {
			if (item.kind === 'fill') return;
			if (item.kind === 'icon' && !ui.showIcons && !isEdited(item)) return;
			if (item.kind === 'station' && !ui.showStations && !isEdited(item)) return;
			drawMarker(item);
		});
		ctx.globalAlpha = ui.mode === 'fill' ? 1 : 0.35;
		model.items.forEach((item) => {
			if (item.kind === 'fill') drawFill(item);
		});
		ctx.globalAlpha = 1;
	}

	const { x, y } = ui.refOffset;
	$('hud-zoom').textContent = `${Math.round(view.scale * 100)}%`;
	$('hud-layer').textContent = `${topLayer()}${peeking ? ' (peek)' : ''}${x || y ? ` · ref ${x >= 0 ? '+' : ''}${x}, ${y >= 0 ? '+' : ''}${y}` : ''}`;
};

/* ---------- hit testing ---------- */

const itemAt = (screenX, screenY) => {
	let best = null;
	let bestDistance = HIT_RADIUS;

	model.items.forEach((item) => {
		if (item.deleted) return;
		// each mode only picks up its own kind of marker
		if (ui.mode === 'fill' ? item.kind !== 'fill' : item.kind === 'fill') return;
		if (item.kind === 'icon' && !ui.showIcons) return;
		if (item.kind === 'station' && !ui.showStations) return;

		const [sx, sy] = toScreen(item.position[0], item.position[1]);
		const distance = Math.hypot(sx - screenX, sy - screenY);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = item;
		}
	});

	return best;
};

/* ---------- ui sync ---------- */

let toastTimer = null;
const toast = (message) => {
	const element = $('toast');
	element.textContent = message;
	element.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		element.hidden = true;
	}, 1800);
};

const save = (quiet = false) => {
	if (!model.dirty) {
		if (!quiet) toast('No changes to save');
		return;
	}
	const count = saveSession(model);
	if (count < 0) {
		toast('Could not write to browser storage');
		return;
	}
	if (!quiet) toast(`Saved ${count} edit${count === 1 ? '' : 's'}`);
	updateStats();
};

const updateStats = () => {
	const icons = model.items.filter((item) => item.kind === 'icon');
	const stations = model.items.filter((item) => item.kind === 'station');
	const edited = model.items.filter(isEdited);
	const deleted = model.items.filter((item) => item.deleted);

	$('stat-icons').textContent = `${icons.filter((item) => !item.deleted).length} / ${icons.length}`;
	$('stat-stations').textContent = `${stations.filter((item) => !item.deleted).length} / ${stations.length}`;
	$('stat-edited').textContent = String(edited.length);
	$('stat-deleted').textContent = String(deleted.length);
	$('stat-unsaved').textContent = model.dirty ? 'yes' : 'no';
};

const updateFillPane = () => {
	const panel = $('fill-selection');
	const empty = $('no-fill');

	$('stat-fills').textContent = String(model.items.filter((item) => item.kind === 'fill' && !item.deleted).length);

	if (!selected || selected.kind !== 'fill') {
		panel.hidden = true;
		empty.hidden = false;
		return;
	}

	panel.hidden = false;
	empty.hidden = true;

	$('fill-new').hidden = !selected.isNew;
	$('fill-color').value = selected.color;
	$('fill-lat').value = selected.lat.toFixed(5);
	$('fill-lon').value = selected.lon.toFixed(5);

	document.querySelectorAll('#fill-maps input').forEach((input) => {
		input.checked = selected.maps.includes(input.value);
	});
};

const updateSelectionPane = () => {
	const panel = $('selection');
	const empty = $('no-selection');

	if (!selected || selected.kind === 'fill') {
		panel.hidden = true;
		empty.hidden = false;
		return;
	}

	panel.hidden = false;
	empty.hidden = true;

	$('sel-kind').textContent = selected.kind === 'station' ? 'station' : `road icon ${selected.order}`;
	$('sel-nws').hidden = !(selected.kind === 'station' && selected.hadLatLon);
	$('sel-edited').hidden = !isEdited(selected);

	$('name-field').hidden = selected.kind !== 'station';
	$('f-name').value = selected.name ?? '';

	const [px, py] = selected.position;
	const { lat, lon } = selected;

	$('f-lat').value = lat.toFixed(5);
	$('f-lon').value = lon.toFixed(5);
	$('f-px').value = px.toFixed(1);
	$('f-py').value = py.toFixed(1);

	$('sel-source').textContent = describePlacement(selected);

	const moved = Math.hypot(px - selected.bakedPosition[0], py - selected.bakedPosition[1]);
	$('sel-moved').textContent = selected.deleted
		? 'deleted'
		: `${moved.toFixed(1)} px from rendered`;

	$('btn-delete').textContent = selected.deleted ? 'Undelete' : 'Delete';
};

const refresh = () => {
	updateSelectionPane();
	updateFillPane();
	updateStats();
	render();
};

const select = (item) => {
	// committing on selection change is the auto-save the workflow expects
	if (item !== selected) save(true);
	selected = item;
	refresh();
};

/* ---------- pointer interaction ---------- */

let pointerDown = null;
let panning = false;

canvas.addEventListener('pointerdown', (event) => {
	canvas.setPointerCapture(event.pointerId);
	pointerDown = {
		x: event.offsetX, y: event.offsetY, tx: view.tx, ty: view.ty,
	};
	panning = false;
});

canvas.addEventListener('pointermove', (event) => {
	if (pointerDown) {
		const dx = event.offsetX - pointerDown.x;
		const dy = event.offsetY - pointerDown.y;
		if (!panning && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
			panning = true;
			canvas.classList.add('panning');
		}
		if (panning) {
			view.tx = pointerDown.tx + dx;
			view.ty = pointerDown.ty + dy;
			render();
		}
		return;
	}

	if (!model) return;
	const next = itemAt(event.offsetX, event.offsetY);
	const [wx, wy] = toWorld(event.offsetX, event.offsetY);
	$('hud-cursor').textContent = `${wx.toFixed(0)}, ${wy.toFixed(0)}`;
	if (next !== hovered) {
		hovered = next;
		canvas.classList.toggle('placing', !hovered && !!selected);
		render();
	}
});

const endPointer = (event) => {
	if (!pointerDown) return;
	const wasPanning = panning;
	pointerDown = null;
	panning = false;
	canvas.classList.remove('panning');
	if (wasPanning || !model) return;

	const hit = itemAt(event.offsetX, event.offsetY);
	if (hit) {
		select(hit);
		return;
	}
	const [wx, wy] = toWorld(event.offsetX, event.offsetY);

	// in fill mode every click on empty map adds another point, whether or not
	// one is already selected. an existing point is moved with the arrow keys
	// or the lat/lon fields, not by clicking elsewhere
	if (ui.mode === 'fill') {
		selected = addFill(model, wx, wy, ui.fillColor, ui.fillMaps);
		// commit straight away: placing a point is a finished action, and
		// saving only on the *next* click would leave the last one unsaved
		save(true);
		refresh();
		return;
	}

	if (selected && !selected.deleted) {
		moveToPixel(model, selected, wx, wy);
		refresh();
	}
};

canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', () => {
	pointerDown = null;
	panning = false;
	canvas.classList.remove('panning');
});

canvas.addEventListener('wheel', (event) => {
	event.preventDefault();
	if (event.shiftKey) {
		zoomAt(event.offsetX, event.offsetY, event.deltaY < 0 ? 1.15 : 1 / 1.15);
		return;
	}
	view.ty -= event.deltaY;
	render();
}, { passive: false });

/* ---------- keyboard ---------- */

const nudge = (dx, dy) => {
	if (!selected || selected.deleted) return;
	const [px, py] = selected.position;
	moveToPixel(model, selected, px + dx, py + dy);
	refresh();
};

const toggleLayer = () => {
	ui.layer = ui.layer === 'generated' ? 'reference' : 'generated';
	document.querySelectorAll('#layer-switch button').forEach((button) => {
		button.classList.toggle('active', button.dataset.layer === ui.layer);
	});
	render();
};

// the rendered map layer is named for the map and region it came from
const generatedMapUrl = () => `/output/${ui.generatedMap}-${region.NAME}.webp`;

const loadGeneratedMap = async () => {
	const image = await new Promise((resolve) => {
		const candidate = new Image();
		candidate.onload = () => resolve(candidate);
		candidate.onerror = () => resolve(null);
		candidate.src = generatedMapUrl();
	});
	layers.generated = image;
	render();
	if (!image) toast(`${generatedMapUrl()} not found — render it first`);
};

const setBlend = (value) => {
	ui.blend = Math.min(1, Math.max(0, value));
	$('blend').value = String(Math.round(ui.blend * 100));
	render();
};

const setRefOffset = (x, y) => {
	ui.refOffset = { x: Math.round(x), y: Math.round(y) };
	$('ref-x').value = String(ui.refOffset.x);
	$('ref-y').value = String(ui.refOffset.y);
	try {
		localStorage.setItem(REF_OFFSET_KEY, JSON.stringify(ui.refOffset));
	} catch {
		// an unavailable store just means the offset is not remembered
	}
	render();
};

const loadRefOffset = () => {
	try {
		const stored = JSON.parse(localStorage.getItem(REF_OFFSET_KEY) ?? 'null');
		if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)) {
			setRefOffset(stored.x, stored.y);
		}
	} catch {
		// keep the default of no offset
	}
};

const deleteSelected = () => {
	if (!selected) return;
	mutate(model, selected, { deleted: !selected.deleted });
	refresh();
};

document.addEventListener('keydown', (event) => {
	if (event.target.matches('input, textarea')) {
		if (event.key === 'Escape') event.target.blur();
		return;
	}
	if (!model) return;

	const key = event.key.toLowerCase();

	if ((event.ctrlKey || event.metaKey) && key === 'z') {
		event.preventDefault();
		if (undo(model)) {
			refresh();
			toast('Undid last change');
		}
		return;
	}
	if ((event.ctrlKey || event.metaKey) && key === 's') {
		event.preventDefault();
		save();
		return;
	}

	// alt + arrows shift the reference image instead of the selection
	if (event.altKey && !event.ctrlKey && !event.metaKey) {
		const shift = event.shiftKey ? 10 : 1;
		const offsets = {
			ArrowLeft: [-shift, 0],
			ArrowRight: [shift, 0],
			ArrowUp: [0, -shift],
			ArrowDown: [0, shift],
		};
		if (offsets[event.key]) {
			event.preventDefault();
			const [dx, dy] = offsets[event.key];
			setRefOffset(ui.refOffset.x + dx, ui.refOffset.y + dy);
			return;
		}
		if (event.key === '0') {
			event.preventDefault();
			setRefOffset(0, 0);
			toast('Reference offset reset');
			return;
		}
	}

	if (event.ctrlKey || event.metaKey || event.altKey) return;

	// hold to peek at whichever layer is underneath
	if (event.code === 'Space') {
		event.preventDefault();
		if (!peeking) {
			peeking = true;
			render();
		}
		return;
	}

	if (event.key === 'Tab') {
		event.preventDefault();
		toggleLayer();
		return;
	}

	// arrows nudge the selection, shift makes it a coarse step
	const step = event.shiftKey ? 10 : 1;
	const nudges = {
		ArrowLeft: [-step, 0],
		ArrowRight: [step, 0],
		ArrowUp: [0, -step],
		ArrowDown: [0, step],
	};

	if (nudges[event.key]) {
		event.preventDefault();
		nudge(...nudges[event.key]);
		return;
	}

	if (event.key === 'Escape') {
		selected = null;
		refresh();
		return;
	}

	if (event.key === 'Delete' || event.key === 'Backspace') {
		event.preventDefault();
		deleteSelected();
		return;
	}

	switch (key) {
		case 'm':
			setMode(ui.mode === 'fill' ? 'markers' : 'fill');
			break;
		case 'b':
			toggleLayer();
			break;
		case 's':
			save();
			break;
		case 'r':
			if (selected) {
				revertItem(model, selected);
				refresh();
				toast('Reverted');
			}
			break;
		case 'x':
			deleteSelected();
			break;
		case 'i':
			$('show-icons').click();
			break;
		case 't':
			$('show-stations').click();
			break;
		case 'h':
			ui.hideOverlays = !ui.hideOverlays;
			render();
			toast(ui.hideOverlays ? 'Overlays hidden' : 'Overlays shown');
			break;
		case '[':
			setBlend(ui.blend - 0.1);
			break;
		case ']':
			setBlend(ui.blend + 0.1);
			break;
		case '+':
		case '=':
			zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.3);
			break;
		case '-':
			zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1 / 1.3);
			break;
		case 'f':
		case '0':
			fitToWindow();
			break;
		case '1':
			view.scale = 1;
			render();
			break;
		case '2':
			view.scale = 2;
			render();
			break;
		case '?':
			$('help').hidden = !$('help').hidden;
			break;
		default:
			break;
	}
});

document.addEventListener('keyup', (event) => {
	if (event.code === 'Space' && peeking) {
		peeking = false;
		render();
	}
});

// a lost focus never delivers the keyup, which would strand the peek
window.addEventListener('blur', () => {
	if (!peeking) return;
	peeking = false;
	render();
});

/* ---------- pane wiring ---------- */

const commitField = (handler) => (event) => {
	if (!selected) return;
	const value = Number(event.target.value);
	if (!Number.isFinite(value)) {
		updateSelectionPane();
		return;
	}
	handler(value);
	refresh();
};

$('f-lat').addEventListener('change', commitField((value) => {
	moveToLatLon(model, selected, value, Number($('f-lon').value));
}));

$('f-lon').addEventListener('change', commitField((value) => {
	moveToLatLon(model, selected, Number($('f-lat').value), value);
}));

$('f-px').addEventListener('change', commitField((value) => {
	moveToPixel(model, selected, value, Number($('f-py').value));
}));

$('f-py').addEventListener('change', commitField((value) => {
	moveToPixel(model, selected, Number($('f-px').value), value);
}));

$('f-name').addEventListener('change', (event) => {
	if (!selected) return;
	const name = event.target.value.trim();
	if (!name) {
		toast('Name cannot be empty');
		updateSelectionPane();
		return;
	}
	const clash = model.items.some((item) => item !== selected
		&& item.kind === 'station'
		&& !item.deleted
		&& item.name === name);
	if (clash) {
		toast(`A station named ${name} already exists`);
		updateSelectionPane();
		return;
	}
	mutate(model, selected, { name });
	refresh();
});

$('btn-save').addEventListener('click', () => save());
$('btn-revert').addEventListener('click', () => {
	if (!selected) return;
	revertItem(model, selected);
	refresh();
	toast('Reverted');
});
$('btn-delete').addEventListener('click', deleteSelected);

document.querySelectorAll('#layer-switch button').forEach((button) => {
	button.addEventListener('click', () => {
		if (button.dataset.layer !== ui.layer) toggleLayer();
	});
});

$('blend').addEventListener('input', (event) => {
	ui.blend = Number(event.target.value) / 100;
	render();
});

const commitRefOffset = () => {
	const x = Number($('ref-x').value);
	const y = Number($('ref-y').value);
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		$('ref-x').value = String(ui.refOffset.x);
		$('ref-y').value = String(ui.refOffset.y);
		return;
	}
	setRefOffset(x, y);
};

$('ref-x').addEventListener('input', commitRefOffset);
$('ref-y').addEventListener('input', commitRefOffset);
$('ref-reset').addEventListener('click', () => {
	setRefOffset(0, 0);
	toast('Reference offset reset');
});

const bindCheckbox = (id, key) => {
	$(id).addEventListener('change', (event) => {
		ui[key] = event.target.checked;
		render();
	});
};

bindCheckbox('show-icons', 'showIcons');
bindCheckbox('show-stations', 'showStations');

const setMode = (mode) => {
	ui.mode = mode;
	document.querySelectorAll('#mode-switch button').forEach((button) => {
		button.classList.toggle('active', button.dataset.mode === mode);
	});
	$('fill-section').hidden = mode !== 'fill';
	$('selection-section').hidden = mode === 'fill';
	// a selection from the other mode would not match the visible pane
	if (selected && (mode === 'fill') !== (selected.kind === 'fill')) selected = null;
	refresh();
};

document.querySelectorAll('#mode-switch button').forEach((button) => {
	button.addEventListener('click', () => setMode(button.dataset.mode));
});

// generated map picker, so the fill work can be judged against the map that
// actually needs the fills
MAP_NAMES.forEach((name) => {
	const option = document.createElement('option');
	option.value = name;
	option.textContent = name;
	$('generated-map').append(option);
});
$('generated-map').value = ui.generatedMap;

$('generated-map').addEventListener('change', (event) => {
	ui.generatedMap = event.target.value;
	loadGeneratedMap();
});

// color picker, populated from every color the maps define
COLOR_NAMES.forEach((name) => {
	const option = document.createElement('option');
	option.value = name;
	option.textContent = name;
	$('fill-color').append(option);
});
$('fill-color').value = ui.fillColor;

$('fill-color').addEventListener('change', (event) => {
	ui.fillColor = event.target.value;
	if (selected?.kind === 'fill') {
		mutate(model, selected, { color: ui.fillColor });
		refresh();
	}
});

// one checkbox per map, so a point can be limited to the maps that need it
MAP_NAMES.forEach((name) => {
	const label = document.createElement('label');
	const input = document.createElement('input');
	input.type = 'checkbox';
	input.value = name;
	input.checked = true;
	input.addEventListener('change', () => {
		const maps = [...document.querySelectorAll('#fill-maps input')]
			.filter((box) => box.checked)
			.map((box) => box.value);
		ui.fillMaps = maps;
		if (selected?.kind === 'fill') {
			mutate(model, selected, { maps });
			refresh();
		}
	});
	label.append(input, document.createTextNode(name));
	$('fill-maps').append(label);
});

const commitFillLatLon = () => {
	if (selected?.kind !== 'fill') return;
	const lat = Number($('fill-lat').value);
	const lon = Number($('fill-lon').value);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
		updateFillPane();
		return;
	}
	moveToLatLon(model, selected, lat, lon);
	refresh();
};

$('fill-lat').addEventListener('change', commitFillLatLon);
$('fill-lon').addEventListener('change', commitFillLatLon);

$('fill-save').addEventListener('click', () => save());
$('fill-revert').addEventListener('click', () => {
	if (!selected) return;
	revertItem(model, selected);
	if (selected.deleted && selected.isNew) selected = null;
	refresh();
	toast('Reverted');
});
$('fill-delete').addEventListener('click', () => {
	if (!selected) return;
	mutate(model, selected, { deleted: !selected.deleted });
	if (selected.deleted) selected = null;
	refresh();
});

const download = (filename, text) => {
	const blob = new Blob([text], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	link.click();
	URL.revokeObjectURL(url);
};

$('export-icons').addEventListener('click', () => {
	save(true);
	download('road-icons.json', serializeIcons(model));
	toast('Exported road-icons.json');
});

$('export-stations').addEventListener('click', () => {
	save(true);
	download('stations.json', serializeStations(model));
	toast('Exported stations.json');
});

$('export-fills').addEventListener('click', () => {
	save(true);
	download('fills.json', serializeFills(model));
	toast('Exported fills.json');
});

$('clear-session').addEventListener('click', () => {
	// eslint-disable-next-line no-alert
	if (!window.confirm('Discard all edits and reload the files as they are on disk?')) return;
	clearSession(model);
	selected = null;
	refresh();
	toast('All edits discarded');
});

$('help-toggle').addEventListener('click', () => {
	$('help').hidden = false;
});
$('help-close').addEventListener('click', () => {
	$('help').hidden = true;
});
$('help').addEventListener('click', (event) => {
	if (event.target === $('help')) $('help').hidden = true;
});

window.addEventListener('beforeunload', (event) => {
	if (!model?.dirty) return;
	event.preventDefault();
	event.returnValue = '';
});

window.addEventListener('resize', resize);

/* ---------- startup ---------- */

const loadImage = (src) => new Promise((resolve) => {
	const image = new Image();
	image.onload = () => resolve(image);
	image.onerror = () => resolve(null);
	image.src = src;
});

const start = async () => {
	try {
		model = await createModel();
	} catch (e) {
		const loading = $('loading');
		loading.className = 'error';
		loading.textContent = `Could not load marker data.\n${e.message}\n\nStart the editor with: npm run editor`;
		return;
	}

	const [reference, generated, icon] = await Promise.all([
		loadImage('/reference-images/radar.webp'),
		loadImage(generatedMapUrl()),
		loadImage('/reference-images/road-icon.png'),
	]);
	layers.reference = reference;
	layers.generated = generated;
	layers.icon = icon;

	const restored = loadSession(model);
	loadRefOffset();
	recomputePositions(model);

	$('loading').hidden = true;
	resize();
	fitToWindow();
	refresh();

	if (!generated) toast(`${generatedMapUrl()} not found — run the render pipeline first`);
	else if (restored > 0) toast(`Restored ${restored} saved edit${restored === 1 ? '' : 's'}`);

	// handle for the devtools console and for editor/verify-ui.mjs
	window.editor = {
		get model() {
			return model;
		},
		get selected() {
			return selected;
		},
		get refOffset() {
			return ui.refOffset;
		},
		ui,
		view,
		toScreen,
		toWorld,
		itemAt,
		select,
		serializeStations: () => serializeStations(model),
		serializeIcons: () => serializeIcons(model),
		serializeFills: () => serializeFills(model),
		setMode,
		projection,
	};
	window.dispatchEvent(new Event('editor-ready'));
};

start();
