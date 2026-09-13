// Minimal static file server for the marker editor.
//
// Serves the repo root so the page can reach /editor, /data, /output and
// /reference-images with plain fetch (file:// blocks those requests).
//   npm run editor

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME_TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.webp': 'image/webp',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
};

const send = (res, status, body, headers = {}) => {
	res.writeHead(status, { 'Cache-Control': 'no-cache', ...headers });
	res.end(body);
};

const server = http.createServer(async (req, res) => {
	try {
		const url = new URL(req.url, `http://${req.headers.host}`);
		let pathname = decodeURIComponent(url.pathname);
		if (pathname === '/') pathname = '/editor/index.html';
		if (pathname.endsWith('/')) pathname += 'index.html';
		// the browser asks for this on its own; answering keeps the console clean
		if (pathname === '/favicon.ico') {
			send(res, 204, '');
			return;
		}

		// resolve inside the repo root only, no traversal above it
		const filePath = path.resolve(ROOT, `.${pathname}`);
		if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
			send(res, 403, 'Forbidden');
			return;
		}

		const data = await fs.readFile(filePath);
		const type = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
		send(res, 200, data, { 'Content-Type': type });
	} catch (e) {
		if (e.code === 'ENOENT' || e.code === 'EISDIR') {
			send(res, 404, `Not found: ${req.url}`);
			return;
		}
		send(res, 500, `Server error: ${e.message}`);
	}
});

server.on('error', (e) => {
	if (e.code === 'EADDRINUSE') {
		console.error(`Port ${PORT} is already in use. Another editor may be running,`);
		console.error('or pick a different port: PORT=8081 npm run editor');
		process.exitCode = 1;
		return;
	}
	throw e;
});

server.listen(PORT, () => {
	console.log(`marker editor running at http://localhost:${PORT}/editor/`);
	console.log(`serving ${ROOT}`);
});
