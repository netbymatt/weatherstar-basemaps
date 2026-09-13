// wrap https functions for easier use
// and add decompression
import https from 'node:https';
import http from 'node:http';
import zlib from 'node:zlib';
import through from 'through';

const defaultHeaders = {
	'User-Agent': 'Net by Matt overpassapi@netbymatt.com',
	'Accept-Encoding': 'gzip, deflate, br',
};

// allow this signature (endpoint[, postData], options);
const httpsGet = (endpoint, postData, _options) => new Promise((resolve, reject) => {
	let options = _options;
	if (options === undefined && (typeof postData === 'object')) {
		options = postData;
	}
	// get type of request
	const request = (endpoint.match(/^https/)) ? https.request : http.request;

	const req = request(endpoint, options, (res) => {
		// default headers
		options.headers = {
			...defaultHeaders,
			...options.headers,
		};

		const output = through(function passThrough(data) {
			this.queue(data);
		});
		// route the data through gzip or just pass through}
		switch (res.headers['content-encoding']) {
			case 'gzip':
				res.pipe(zlib.createGunzip()).pipe(output);
				break;
			case 'deflate':
				res.pipe(zlib.createInflate()).pipe(output);
				break;
			case 'br':
				res.pipe(zlib.createBrotliDecompress()).pipe(output);
				break;
			default:
				res.pipe(output);
		}

		const buffers = [];
		output.on('data', (data) => buffers.push(data));
		output.on('end', () => resolve(Buffer.concat(buffers).toString()));
		output.on('error', (e) => reject(e));
	});
	req.on('error', (e) => reject(e));
	if (typeof postData === 'string') req.write(postData);
	req.end();
});

export default httpsGet;
