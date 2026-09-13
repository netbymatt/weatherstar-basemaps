import httpsGet from './https-wrapper.mjs';
import queries from './queries.mjs';

const endpoint = 'https://overpass-api.de/api/interpreter';
// const endpoint = 'http://3.82.244.102/api/interpreter';

const get = (bounds, type) => {
	// build a query from the bounds
	const queryTemplate = queries[type];
	if (!queryTemplate) throw new Error(`Unknown type ${type}`);
	const query = queryTemplate(bounds);
	return httpsGet(endpoint, query, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
			'User-Agent': 'Net by Matt Weatherstar (weatherstar@netbymatt.com)',
			Referer: 'https://weatherstar.netbymatt.com/',
		},
	});
};

export default get;
