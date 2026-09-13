// Drives the editor in headless Chrome over the DevTools Protocol and walks
// through the real interactions: select a marker, move it, check the pane,
// undo, delete, export.
//
//   npm run editor        # in one terminal
//   npm run editor:verify-ui
//
// Pass --screenshot <path> to also capture the viewport.

import { spawn } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_UNDER_TEST = process.env.EDITOR_URL ?? 'http://localhost:8080/editor/';
const CHROME = process.env.CHROME_PATH ?? 'google-chrome';
const screenshotIndex = process.argv.indexOf('--screenshot');
const screenshotPath = screenshotIndex === -1 ? null : process.argv[screenshotIndex + 1];

const WIDTH = 1600;
const HEIGHT = 900;

let failures = 0;
const check = (label, ok, detail = '') => {
	if (!ok) failures += 1;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- tiny CDP client ---------- */

const connect = async (port) => {
	let targets;
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
			if (targets.some((t) => t.type === 'page')) break;
		} catch {
			// browser still starting
		}
		await sleep(100);
	}
	const page = targets?.find((t) => t.type === 'page');
	if (!page) throw new Error('no page target; is chrome installed?');

	const socket = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		socket.onopen = resolve;
		socket.onerror = reject;
	});

	let nextId = 1;
	const pending = new Map();
	const events = [];

	socket.onmessage = (message) => {
		const data = JSON.parse(message.data);
		if (data.id && pending.has(data.id)) {
			const { resolve, reject } = pending.get(data.id);
			pending.delete(data.id);
			if (data.error) reject(new Error(data.error.message));
			else resolve(data.result);
			return;
		}
		events.push(data);
	};

	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const id = nextId;
		nextId += 1;
		pending.set(id, { resolve, reject });
		socket.send(JSON.stringify({ id, method, params }));
	});

	return { send, events, close: () => socket.close() };
};

const evaluate = async (cdp, expression) => {
	const result = await cdp.send('Runtime.evaluate', {
		expression,
		awaitPromise: true,
		returnByValue: true,
	});
	if (result.exceptionDetails) {
		throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
	}
	return result.result.value;
};

// navigate afresh and wait for the app to finish starting up again
const reload = async (cdp) => {
	await cdp.send('Page.navigate', { url: URL_UNDER_TEST }).catch(() => {});
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const ready = await evaluate(cdp, 'Boolean(window.editor)').catch(() => false);
		if (ready) return true;
		await sleep(200);
	}
	return false;
};

const clickAt = async (cdp, x, y) => {
	const base = {
		x, y, button: 'left', clickCount: 1, buttons: 1,
	};
	await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0 });
	await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
	await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
	await sleep(60);
};

/* ---------- the run ---------- */

const userDataDir = await mkdtemp(path.join(tmpdir(), 'editor-cdp-'));
const chrome = spawn(CHROME, [
	'--headless=new',
	'--remote-debugging-port=0',
	`--user-data-dir=${userDataDir}`,
	`--window-size=${WIDTH},${HEIGHT}`,
	'--no-first-run',
	'--no-default-browser-check',
	'--disable-gpu',
	'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

// chrome prints the chosen debugging port on stderr
const port = await new Promise((resolve, reject) => {
	let buffer = '';
	const timer = setTimeout(() => reject(new Error('timed out waiting for chrome')), 15000);
	chrome.stderr.on('data', (chunk) => {
		buffer += chunk;
		const match = buffer.match(/ws:\/\/127\.0\.0\.1:(\d+)\//);
		if (match) {
			clearTimeout(timer);
			resolve(Number(match[1]));
		}
	});
	chrome.on('exit', (code) => reject(new Error(`chrome exited early (${code})`)));
});

const cdp = await connect(port);
const consoleErrors = [];

await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Log.enable');

cdp.events.push = function push(event) {
	// the app warns before unload when there are unsaved edits, and in headless
	// chrome that dialog blocks navigation until it is answered
	if (event.method === 'Page.javascriptDialogOpening') {
		cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
	}
	if (event.method === 'Runtime.exceptionThrown') {
		consoleErrors.push(event.params.exceptionDetails.exception?.description
			?? event.params.exceptionDetails.text);
	}
	if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error') {
		consoleErrors.push(event.params.entry.text);
	}
	return Array.prototype.push.call(this, event);
};

try {
	await cdp.send('Page.navigate', { url: URL_UNDER_TEST });

	// wait for the app to finish loading data and images
	let ready = false;
	for (let attempt = 0; attempt < 100; attempt += 1) {
		ready = await evaluate(cdp, 'Boolean(window.editor)').catch(() => false);
		if (ready) break;
		await sleep(200);
	}
	check('page loads and exposes the editor', ready);
	if (!ready) throw new Error('editor never became ready');

	// a previous run (or a crashed one) can leave edits in localStorage, which
	// would skew every count below; start from the files as they are on disk
	const hadSession = await evaluate(cdp, `(() => {
		const stored = localStorage.getItem('basic-map-editor-edits-v1');
		localStorage.removeItem('basic-map-editor-edits-v1');
		return stored ? JSON.parse(stored).length : 0;
	})()`);
	if (hadSession) {
		console.log(`      (cleared ${hadSession} leftover session edits)`);
		await reload(cdp);
	}

	const counts = await evaluate(cdp, `(() => {
		const items = window.editor.model.items;
		return {
			total: items.length,
			icons: items.filter((i) => i.kind === 'icon').length,
			stations: items.filter((i) => i.kind === 'station').length,
			fills: items.filter((i) => i.kind === 'fill').length,
			inBoundsNonFill: items.filter((i) => i.kind !== 'fill' && i.position[0] >= 0 && i.position[0] <= 5100 && i.position[1] >= 0 && i.position[1] <= 3200).length,
			positioned: items.filter((i) => Number.isFinite(i.position[0]) && Number.isFinite(i.position[1])).length,
			inBounds: items.filter((i) => i.position[0] >= 0 && i.position[0] <= 5100 && i.position[1] >= 0 && i.position[1] <= 3200).length,
		};
	})()`);

	// expectations come from the files rather than fixed numbers, so editing
	// the data does not break the checks
	const onDisk = {
		stations: Object.keys(await fetch('http://localhost:8080/data/stations.json').then((r) => r.json())).length,
		icons: (await fetch('http://localhost:8080/data/road-icons.json').then((r) => r.json())).length,
		fills: await fetch('http://localhost:8080/data/fills.json').then((r) => (r.ok ? r.json() : [])).then((f) => f.length),
	};

	check('loads every station', counts.stations === onDisk.stations, `${counts.stations} of ${onDisk.stations}`);
	check('loads every road icon', counts.icons === onDisk.icons, `${counts.icons} of ${onDisk.icons}`);
	check('loads every fill point', counts.fills === onDisk.fills, `${counts.fills} of ${onDisk.fills}`);
	check('every marker has a finite position', counts.positioned === counts.total);
	// fill points are placed by hand and may sit outside the region on purpose
	check('every marker lands on the map', counts.inBoundsNonFill === counts.total - counts.fills, `${counts.inBoundsNonFill}/${counts.total - counts.fills}`);

	// an element that sets its own display can stay on screen despite [hidden],
	// and an overlay left up swallows every click meant for the canvas
	const overlays = await evaluate(cdp, `(() => {
		const visible = (id) => {
			const element = document.getElementById(id);
			return getComputedStyle(element).display !== 'none';
		};
		const rect = document.getElementById('canvas').getBoundingClientRect();
		const topAtCenter = document.elementFromPoint(rect.width / 2, rect.height / 2);
		return {
			loading: visible('loading'),
			help: visible('help'),
			nameField: visible('name-field'),
			topElement: topAtCenter?.id ?? topAtCenter?.tagName ?? null,
			canvasSize: [rect.width, rect.height],
		};
	})()`);

	check('loading overlay is dismissed', overlays.loading === false);
	check('help dialog starts closed', overlays.help === false);
	check('canvas is what the cursor hits', overlays.topElement === 'canvas', String(overlays.topElement));
	check('canvas has real dimensions', overlays.canvasSize[0] > 800 && overlays.canvasSize[1] > 400, overlays.canvasSize.join(' x '));

	// pick a road icon and find it on screen
	const target = await evaluate(cdp, `(() => {
		const item = window.editor.model.items.find((i) => i.kind === 'icon');
		const [sx, sy] = window.editor.toScreen(item.position[0], item.position[1]);
		const rect = document.getElementById('canvas').getBoundingClientRect();
		return { id: item.id, order: item.order, sx, sy, left: rect.left, top: rect.top, world: item.position };
	})()`);

	await clickAt(cdp, target.left + target.sx, target.top + target.sy);

	const afterSelect = await evaluate(cdp, `(() => ({
		selectedId: window.editor.selected?.id ?? null,
		paneVisible: !document.getElementById('selection').hidden,
		lat: document.getElementById('f-lat').value,
		lon: document.getElementById('f-lon').value,
		px: document.getElementById('f-px').value,
		py: document.getElementById('f-py').value,
		source: document.getElementById('sel-source').textContent,
	}))()`);
	check('pane reports file placement', afterSelect.source === 'file lat/lon', afterSelect.source);

	check('clicking a marker selects it', afterSelect.selectedId === target.id, afterSelect.selectedId ?? 'none');
	check('selection pane opens', afterSelect.paneVisible);
	check('pane shows lat/lon', Number(afterSelect.lat) !== 0 && Number(afterSelect.lon) !== 0, `${afterSelect.lat}, ${afterSelect.lon}`);
	check('pane shows map x/y', Math.abs(Number(afterSelect.px) - target.world[0]) < 0.2);

	// move it by clicking empty map to the right. markers are dense at fit
	// zoom, so find a spot with clearance or the click just selects a neighbour
	const spot = await evaluate(cdp, `(() => {
		for (let dx = 40; dx <= 300; dx += 6) {
			const x = ${target.sx} + dx;
			const y = ${target.sy};
			const clear = window.editor.model.items.every((item) => {
				if (item.deleted) return true;
				const [ix, iy] = window.editor.toScreen(item.position[0], item.position[1]);
				return Math.hypot(ix - x, iy - y) > 30;
			});
			if (clear) return { x, y, dx };
		}
		return null;
	})()`);
	check('found empty map to click', spot !== null);
	if (!spot) throw new Error('nowhere empty to place');

	await clickAt(cdp, target.left + spot.x, target.top + spot.y);

	const afterMove = await evaluate(cdp, `(() => {
		const item = window.editor.model.items.find((i) => i.id === ${JSON.stringify(target.id)});
		return {
			lat: item.lat,
			lon: item.lon,
			edited: item.lat !== item.originalLat || item.lon !== item.originalLon,
			dx: item.position[0] - ${target.world[0]},
			dy: item.position[1] - ${target.world[1]},
			paneLat: document.getElementById('f-lat').value,
			editedBadge: !document.getElementById('sel-edited').hidden,
			source: document.getElementById('sel-source').textContent,
			statEdited: document.getElementById('stat-edited').textContent,
			moved: document.getElementById('sel-moved').textContent,
		};
	})()`);

	const expectedDx = spot.dx / (await evaluate(cdp, 'window.editor.view.scale'));
	check('clicking the map moves the selection', afterMove.edited);
	check('moves by the clicked distance', Math.abs(afterMove.dx - expectedDx) < 1.5, `dx ${afterMove.dx.toFixed(1)} vs ${expectedDx.toFixed(1)}`);
	check('stays on the same row', Math.abs(afterMove.dy) < 1.5, `dy ${afterMove.dy.toFixed(2)}`);
	check('writes a lat/lon', Number.isFinite(afterMove.lat) && Number.isFinite(afterMove.lon), `${afterMove.lat}, ${afterMove.lon}`);
	check('rounds lat/lon to 5 decimals', String(afterMove.lat).split('.')[1]?.length <= 5, String(afterMove.lat));
	check('pane marks it edited', afterMove.editedBadge);
	check('placement switches to corrected', afterMove.source === 'corrected lat/lon', afterMove.source);
	check('edited count updates', afterMove.statEdited === '1', afterMove.statEdited);
	check('reports distance from rendered', /px from rendered$/.test(afterMove.moved), afterMove.moved);

	// the corrected icon must now export with lat/lon
	const iconsExport = await evaluate(cdp, 'window.editor.serializeIcons()');
	const exportedLine = iconsExport.split('\n').find((line) => line.includes('"lat"'));
	check('export writes lat/lon for the correction', Boolean(exportedLine), exportedLine?.trim());
	check('export keeps every icon', iconsExport.split('\n').length === onDisk.icons + 2, `${iconsExport.split('\n').length} lines`);

	// undo
	await cdp.send('Input.dispatchKeyEvent', {
		type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2,
	});
	await cdp.send('Input.dispatchKeyEvent', {
		type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2,
	});
	await sleep(120);

	const afterUndo = await evaluate(cdp, `(() => {
		const item = window.editor.model.items.find((i) => i.id === ${JSON.stringify(target.id)});
		return { lat: item.lat, originalLat: item.originalLat, statEdited: document.getElementById('stat-edited').textContent };
	})()`);
	check('ctrl+z undoes the move', afterUndo.lat === afterUndo.originalLat, `lat ${afterUndo.lat}`);
	check('edited count returns to zero', afterUndo.statEdited === '0', afterUndo.statEdited);

	// station selection, rename guard and delete
	const stationProbe = await evaluate(cdp, `(() => {
		const item = window.editor.model.items.find((i) => i.kind === 'station' && i.hadLatLon);
		window.editor.select(item);
		return {
			id: item.id,
			name: item.name,
			nwsBadge: !document.getElementById('sel-nws').hidden,
			nameField: !document.getElementById('name-field').hidden,
			nameValue: document.getElementById('f-name').value,
			source: document.getElementById('sel-source').textContent,
		};
	})()`);
	check('selecting a station shows its name', stationProbe.nameValue === stationProbe.name, stationProbe.nameValue);
	check('station with NWS lat/lon is flagged blue', stationProbe.nwsBadge);
	check('name field shows for stations', stationProbe.nameField);

	// and is actually hidden, not merely marked hidden, for road icons
	const iconNameField = await evaluate(cdp, `(() => {
		window.editor.select(window.editor.model.items.find((i) => i.kind === 'icon'));
		return getComputedStyle(document.getElementById('name-field')).display !== 'none';
	})()`);
	check('name field is hidden for road icons', iconNameField === false);
	check('reports file lat/lon placement', stationProbe.source === 'file lat/lon', stationProbe.source);

	const deleteProbe = await evaluate(cdp, `(() => {
		// re-select the station; the probe above moved the selection to an icon
		window.editor.select(window.editor.model.items.find((i) => i.id === ${JSON.stringify(stationProbe.id)}));
		document.getElementById('btn-delete').click();
		const item = window.editor.model.items.find((i) => i.id === ${JSON.stringify(stationProbe.id)});
		const exported = window.editor.serializeStations();
		return {
			deleted: item.deleted,
			buttonLabel: document.getElementById('btn-delete').textContent,
			inExport: Object.hasOwn(JSON.parse(exported), item.name),
			statDeleted: document.getElementById('stat-deleted').textContent,
		};
	})()`);
	check('delete marks the station', deleteProbe.deleted);
	check('delete button offers undelete', deleteProbe.buttonLabel === 'Undelete', deleteProbe.buttonLabel);
	check('deleted station leaves the export', deleteProbe.inExport === false);
	check('deleted count updates', deleteProbe.statDeleted === '1', deleteProbe.statDeleted);

	// restore and confirm a clean export matches disk
	const cleanExport = await evaluate(cdp, `(() => {
		const items = window.editor.model.items;
		items.forEach((item) => {
			item.lat = item.originalLat;
			item.lon = item.originalLon;
			item.name = item.originalName;
			item.deleted = false;
		});
		return { stations: window.editor.serializeStations(), icons: window.editor.serializeIcons() };
	})()`);

	const diskIcons = await fetch('http://localhost:8080/data/road-icons.json').then((r) => r.text());
	check('clean icon export matches disk byte for byte', cleanExport.icons === diskIcons);
	check('clean station export keeps all stations', Object.keys(JSON.parse(cleanExport.stations)).length === onDisk.stations, `${Object.keys(JSON.parse(cleanExport.stations)).length}`);

	// layer toggle
	const layerProbe = await evaluate(cdp, `(() => {
		const before = document.getElementById('hud-layer').textContent;
		document.querySelector('#layer-switch button[data-layer="reference"]').click();
		const after = document.getElementById('hud-layer').textContent;
		document.querySelector('#layer-switch button[data-layer="generated"]').click();
		return { before, after };
	})()`);
	check('layer switch toggles the base image', layerProbe.before === 'generated' && layerProbe.after === 'reference', `${layerProbe.before} → ${layerProbe.after}`);

	/* ---------- layer shortcuts and reference offset ---------- */

	const pressKey = async (key, code, keyCode, modifiers = 0) => {
		await cdp.send('Input.dispatchKeyEvent', {
			type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers,
		});
		await cdp.send('Input.dispatchKeyEvent', {
			type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers,
		});
		await sleep(60);
	};

	const readLayer = () => evaluate(cdp, "document.getElementById('hud-layer').textContent");

	await pressKey('b', 'KeyB', 66);
	check('b toggles to reference', (await readLayer()).startsWith('reference'));
	await pressKey('Tab', 'Tab', 9);
	check('tab toggles back to generated', (await readLayer()).startsWith('generated'));

	// space is hold-to-peek, so press and release are checked separately
	await cdp.send('Input.dispatchKeyEvent', {
		type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32,
	});
	await sleep(60);
	const peeked = await readLayer();
	await cdp.send('Input.dispatchKeyEvent', {
		type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32,
	});
	await sleep(60);
	const unpeeked = await readLayer();
	check('holding space peeks the other layer', peeked.startsWith('reference') && peeked.includes('peek'), peeked);
	check('releasing space restores the layer', unpeeked.startsWith('generated'), unpeeked);

	// blend keys
	const blendProbe = await evaluate(cdp, "document.getElementById('blend').value");
	await pressKey('[', 'BracketLeft', 219);
	const blendDown = await evaluate(cdp, "document.getElementById('blend').value");
	await pressKey(']', 'BracketRight', 221);
	const blendUp = await evaluate(cdp, "document.getElementById('blend').value");
	check('[ lowers the blend', Number(blendDown) < Number(blendProbe), `${blendProbe} → ${blendDown}`);
	check('] raises the blend', Number(blendUp) > Number(blendDown), `${blendDown} → ${blendUp}`);

	// alt + arrows shift the reference image
	await pressKey('ArrowRight', 'ArrowRight', 39, 1);
	await pressKey('ArrowRight', 'ArrowRight', 39, 1);
	await pressKey('ArrowDown', 'ArrowDown', 40, 1 | 8);
	const offsetProbe = await evaluate(cdp, `({
		x: Number(document.getElementById('ref-x').value),
		y: Number(document.getElementById('ref-y').value),
		hud: document.getElementById('hud-layer').textContent,
		stored: JSON.parse(localStorage.getItem('basic-map-editor-reference-offset-v1') ?? 'null'),
	})`);
	check('alt+arrow shifts the reference', offsetProbe.x === 2, `x ${offsetProbe.x}`);
	check('alt+shift+arrow shifts by 10', offsetProbe.y === 10, `y ${offsetProbe.y}`);
	check('hud reports the reference offset', offsetProbe.hud.includes('ref +2, +10'), offsetProbe.hud);
	check('reference offset persists', offsetProbe.stored?.x === 2 && offsetProbe.stored?.y === 10);

	// the offset must not touch marker positions or exported data
	// with an offset active, positions and exported bytes must be identical to
	// what they are with no offset at all
	const offsetIsolation = await evaluate(cdp, `(() => {
		const item = window.editor.model.items.find((i) => i.kind === 'icon');
		const setOffset = (x, y) => {
			const inputX = document.getElementById('ref-x');
			const inputY = document.getElementById('ref-y');
			inputX.value = String(x);
			inputY.value = String(y);
			inputX.dispatchEvent(new Event('input', { bubbles: true }));
		};

		setOffset(0, 0);
		const clean = { position: [...item.position], icons: window.editor.serializeIcons() };
		setOffset(140, -60);
		const shifted = { position: [...item.position], icons: window.editor.serializeIcons() };
		setOffset(2, 10);
		return { clean, shifted };
	})()`);
	check(
		'offset leaves marker positions alone',
		offsetIsolation.clean.position[0] === offsetIsolation.shifted.position[0]
		&& offsetIsolation.clean.position[1] === offsetIsolation.shifted.position[1],
		offsetIsolation.shifted.position.map((v) => v.toFixed(1)).join(', '),
	);
	check('offset leaves exported data alone', offsetIsolation.clean.icons === offsetIsolation.shifted.icons);

	// the offset has to actually move drawn pixels, not just the readouts
	const pixelProbe = await evaluate(cdp, `(() => {
		const element = document.getElementById('canvas');
		// the app already holds this context, so this is the same one
		const context = element.getContext('2d');
		const sample = () => {
			const data = context.getImageData(200, 200, 400, 200).data;
			let hash = 0;
			for (let i = 0; i < data.length; i += 97) hash = (hash * 31 + data[i]) % 1000000007;
			return hash;
		};
		const setOffset = (x, y) => {
			const input = document.getElementById('ref-x');
			const other = document.getElementById('ref-y');
			input.value = String(x);
			other.value = String(y);
			input.dispatchEvent(new Event('input', { bubbles: true }));
		};

		// show the reference alone so only its own movement can change pixels
		document.querySelector('#layer-switch button[data-layer="reference"]').click();
		setOffset(0, 0);
		const atZero = sample();
		setOffset(120, 80);
		const shifted = sample();
		setOffset(0, 0);
		const restored = sample();
		document.querySelector('#layer-switch button[data-layer="generated"]').click();
		return { atZero, shifted, restored };
	})()`);

	check('offset actually redraws the reference image', pixelProbe.shifted !== pixelProbe.atZero, `${pixelProbe.atZero} → ${pixelProbe.shifted}`);
	check('clearing the offset restores the image', pixelProbe.restored === pixelProbe.atZero);

	// typed input and reset
	const typedProbe = await evaluate(cdp, `(() => {
		const input = document.getElementById('ref-x');
		input.value = '-25';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		return window.editor.refOffset ?? null;
	})()`);
	check('typing into the offset field works', typedProbe?.x === -25, JSON.stringify(typedProbe));

	const resetProbe = await evaluate(cdp, `(() => {
		document.getElementById('ref-reset').click();
		return {
			x: Number(document.getElementById('ref-x').value),
			y: Number(document.getElementById('ref-y').value),
			hud: document.getElementById('hud-layer').textContent,
		};
	})()`);
	check('reset clears the offset', resetProbe.x === 0 && resetProbe.y === 0);
	check('hud drops the offset when zero', !resetProbe.hud.includes('ref'), resetProbe.hud);

	// visibility shortcuts
	const visibilityProbe = await evaluate(cdp, `(() => {
		const before = {
			icons: document.getElementById('show-icons').checked,
			stations: document.getElementById('show-stations').checked,
		};
		return before;
	})()`);
	await pressKey('i', 'KeyI', 73);
	await pressKey('t', 'KeyT', 84);
	const afterVisibility = await evaluate(cdp, `({
		icons: document.getElementById('show-icons').checked,
		stations: document.getElementById('show-stations').checked,
	})`);
	check('i toggles road icons', afterVisibility.icons !== visibilityProbe.icons);
	check('t toggles station labels', afterVisibility.stations !== visibilityProbe.stations);

	// restore visibility for the screenshot
	await pressKey('i', 'KeyI', 73);
	await pressKey('t', 'KeyT', 84);

	/* ---------- fill mode ---------- */

	const fillEntry = await evaluate(cdp, `(() => {
		window.editor.setMode('fill');
		return {
			fillPaneVisible: getComputedStyle(document.getElementById('fill-section')).display !== 'none',
			markerPaneHidden: getComputedStyle(document.getElementById('selection-section')).display === 'none',
			colorOptions: [...document.querySelectorAll('#fill-color option')].map((o) => o.value),
			mapBoxes: [...document.querySelectorAll('#fill-maps input')].map((i) => i.value),
			};
	})()`);
	check('fill mode shows the fill pane', fillEntry.fillPaneVisible);
	check('fill mode hides the marker pane', fillEntry.markerPaneHidden);
	check('color picker lists map colors', fillEntry.colorOptions.includes('stateFill'), fillEntry.colorOptions.join(', '));
	check('map checkboxes match MAPS', fillEntry.mapBoxes.join(',') === 'radar,forecast', fillEntry.mapBoxes.join(','));

	// click empty map to add a point
	const addProbe = await evaluate(cdp, `(() => {
		// northern mexico: inside the region bounds, on land, and well away
		// from the other fill points
		const [px, py] = window.editor.toScreen(...window.editor.projection.forward([-108, 28]));
		const rect = document.getElementById('canvas').getBoundingClientRect();
		return { x: rect.left + px, y: rect.top + py, before: window.editor.model.items.filter((i) => i.kind === 'fill').length };
	})()`);
	await clickAt(cdp, addProbe.x, addProbe.y);

	const added = await evaluate(cdp, `(() => {
		const fills = window.editor.model.items.filter((i) => i.kind === 'fill');
		const sel = window.editor.selected;
		return {
			count: fills.length,
			selectedIsFill: sel?.kind === 'fill',
			isNew: sel?.isNew,
			color: sel?.color,
			maps: sel?.maps,
			newBadge: !document.getElementById('fill-new').hidden,
		};
	})()`);
	check('clicking empty map adds a fill point', added.count === addProbe.before + 1, `${addProbe.before} → ${added.count}`);
	check('the new point is selected', added.selectedIsFill && added.isNew === true);
	check('it takes the current color', added.color === 'stateFill', String(added.color));
	check('it applies to every map by default', (added.maps ?? []).join(',') === 'radar,forecast', (added.maps ?? []).join(','));
	check('pane flags it as new', added.newBadge);

	// the export has to include it, in the road-icons style
	const fillsExport = await evaluate(cdp, 'window.editor.serializeFills()');
	const fillLines = fillsExport.trim().split('\n');
	check('fills export includes the new point', fillLines.length === added.count + 2, `${fillLines.length} lines`);
	check('fills export uses the repo style', /^\t\{"lat": -?\d+(\.\d+)?, "lon": -?\d+(\.\d+)?, "color": "\w+", "maps": \[.*\]\}/.test(fillLines[1]), fillLines[1]);
	let fillsParse = false;
	try {
		JSON.parse(fillsExport);
		fillsParse = true;
	} catch {
		fillsParse = false;
	}
	check('fills export parses as json', fillsParse);

	// several clicks in a row have to add several points, not shuffle one
	// around. this is the shape of the bug where only one fill ever landed
	// in the exported file
	const spots = [[-104, 26.5], [-101, 29.5], [-98, 25.5]];
	const beforeMulti = await evaluate(cdp, "window.editor.model.items.filter((i) => i.kind === 'fill').length");
	// eslint-disable-next-line no-restricted-syntax
	for (const [lon, lat] of spots) {
		const at = await evaluate(cdp, `(() => {
			const [px, py] = window.editor.toScreen(...window.editor.projection.forward([${lon}, ${lat}]));
			const rect = document.getElementById('canvas').getBoundingClientRect();
			return { x: rect.left + px, y: rect.top + py };
		})()`);
		await clickAt(cdp, at.x, at.y);
	}

	const multi = await evaluate(cdp, `(() => {
		const fills = window.editor.model.items.filter((i) => i.kind === 'fill' && !i.deleted);
		const exported = window.editor.serializeFills();
		return {
			count: fills.length,
			distinctAdded: new Set(fills.slice(-${spots.length}).map((f) => f.lat + ',' + f.lon)).size,
			exportedCount: JSON.parse(exported).length,
			stored: JSON.parse(localStorage.getItem('basic-map-editor-edits-v1') ?? '[]').filter((e) => String(e.id).startsWith('fill')).length,
		};
	})()`);

	check('each click adds another fill point', multi.count === beforeMulti + spots.length, `${beforeMulti} + ${spots.length} → ${multi.count}`);
	check('the added points are all distinct', multi.distinctAdded === spots.length, `${multi.distinctAdded} of ${spots.length}`);
	check('every added point reaches the export', multi.exportedCount === multi.count, `${multi.exportedCount} exported`);
	check('every added point is saved to the session', multi.stored >= spots.length, `${multi.stored} stored`);

	// and they survive a reload, since they exist only in the session
	check('editor comes back after a reload', await reload(cdp));
	const afterReload = await evaluate(cdp, `(() => {
		const fills = window.editor.model.items.filter((i) => i.kind === 'fill' && !i.deleted);
		return { count: fills.length, exported: JSON.parse(window.editor.serializeFills()).length };
	})()`);
	check('added points survive a reload', afterReload.count === multi.count, `${afterReload.count} of ${multi.count}`);
	check('and are still exported after reload', afterReload.exported === multi.count, `${afterReload.exported}`);

	// clean up the session so repeat runs start fresh
	await evaluate(cdp, "localStorage.removeItem('basic-map-editor-edits-v1')");
	await reload(cdp);
	await evaluate(cdp, "window.editor.setMode('fill')");

	// changing color and map scope. nothing is selected after a reload, so
	// pick a fill point first
	const editProbe = await evaluate(cdp, `(() => {
		window.editor.select(window.editor.model.items.find((i) => i.kind === 'fill' && !i.deleted));
		const picker = document.getElementById('fill-color');
		picker.value = 'water';
		picker.dispatchEvent(new Event('change', { bubbles: true }));
		const radar = [...document.querySelectorAll('#fill-maps input')].find((i) => i.value === 'radar');
		radar.checked = false;
		radar.dispatchEvent(new Event('change', { bubbles: true }));
		const sel = window.editor.selected;
		return { color: sel.color, maps: [...sel.maps], exported: window.editor.serializeFills() };
	})()`);
	check('color picker updates the point', editProbe.color === 'water', editProbe.color);
	check('unchecking a map narrows its scope', editProbe.maps.join(',') === 'forecast', editProbe.maps.join(','));
	check('export carries color and maps', editProbe.exported.includes('"color": "water", "maps": ["forecast"]'));

	// undo removes the point entirely
	await cdp.send('Input.dispatchKeyEvent', {
		type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2,
	});
	await cdp.send('Input.dispatchKeyEvent', {
		type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2,
	});
	await sleep(120);
	// three undos: map scope, color, then the add itself
	for (let i = 0; i < 2; i += 1) {
		await cdp.send('Input.dispatchKeyEvent', {
			type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2,
		});
		await cdp.send('Input.dispatchKeyEvent', {
			type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2,
		});
		await sleep(120);
	}
	const afterFillUndo = await evaluate(cdp, "window.editor.model.items.filter((i) => i.kind === 'fill').length");
	check('undo removes an added fill point', afterFillUndo === addProbe.before, `${afterFillUndo} vs ${addProbe.before}`);

	// back to markers mode, fills should not be selectable there
	const backToMarkers = await evaluate(cdp, `(() => {
		window.editor.setMode('markers');
		const fill = window.editor.model.items.find((i) => i.kind === 'fill');
		const [px, py] = window.editor.toScreen(fill.position[0], fill.position[1]);
		return {
			hit: window.editor.itemAt(px, py)?.kind ?? null,
			fillPaneHidden: getComputedStyle(document.getElementById('fill-section')).display === 'none',
		};
	})()`);
	check('markers mode ignores fill crosshairs', backToMarkers.hit !== 'fill', String(backToMarkers.hit));
	check('markers mode hides the fill pane', backToMarkers.fillPaneHidden);

	// zoom shortcuts
	await pressKey('1', 'Digit1', 49);
	const zoom100 = await evaluate(cdp, 'window.editor.view.scale');
	await pressKey('2', 'Digit2', 50);
	const zoom200 = await evaluate(cdp, 'window.editor.view.scale');
	await pressKey('f', 'KeyF', 70);
	const zoomFit = await evaluate(cdp, 'window.editor.view.scale');
	check('1 zooms to 100%', zoom100 === 1, String(zoom100));
	check('2 zooms to 200%', zoom200 === 2, String(zoom200));
	check('f fits the window', zoomFit < 0.5 && zoomFit > 0.1, zoomFit.toFixed(3));

	if (screenshotPath === 'FILLMODE') {
		await evaluate(cdp, `(() => {
			window.editor.setMode('fill');
			document.getElementById('generated-map').value = 'forecast';
			document.getElementById('generated-map').dispatchEvent(new Event('change', { bubbles: true }));
			const fill = window.editor.model.items.find((i) => i.kind === 'fill' && i.lon < -120);
			window.editor.select(fill);
			window.editor.view.scale = 0.42;
			window.editor.view.tx = 250 - fill.position[0] * 0.42;
			window.editor.view.ty = 300 - fill.position[1] * 0.42;
			window.dispatchEvent(new Event('resize'));
		})()`);
		await sleep(1200);
		const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
		await writeFile('/tmp/editor-fill.png', Buffer.from(shot.data, 'base64'));
		console.log('\nfill mode screenshot written');
	} else if (screenshotPath) {
		// stage a moved marker so the red/green indicators are visible
		await evaluate(cdp, `(() => {
			document.querySelector('#layer-switch button[data-layer="generated"]').click();
			const item = window.editor.model.items.find((i) => i.kind === 'station' && i.name === 'PIH')
				?? window.editor.model.items.find((i) => i.kind === 'station');
			window.editor.view.scale = 1.6;
			const [px, py] = item.position;
			window.editor.view.tx = 630 - px * 1.6;
			window.editor.view.ty = 450 - py * 1.6;
			window.editor.select(item);
			window.dispatchEvent(new Event('resize'));
		})()`);
		// place it 70px away by clicking, exercising the real path
		const demo = await evaluate(cdp, `(() => {
			const item = window.editor.selected;
			const [sx, sy] = window.editor.toScreen(item.position[0], item.position[1]);
			const rect = document.getElementById('canvas').getBoundingClientRect();
			return { x: rect.left + sx + 70, y: rect.top + sy + 45 };
		})()`);
		await clickAt(cdp, demo.x, demo.y);
		await sleep(300);
		const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
		await writeFile(screenshotPath, Buffer.from(shot.data, 'base64'));
		console.log(`\nscreenshot written to ${screenshotPath}`);
	}

	check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} finally {
	cdp.close();
	chrome.kill();
	await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}

console.log(failures === 0 ? '\neditor ui verified' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
