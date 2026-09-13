// the overpass api is very restrictive
// make a best effort to queue requests and follow the status published at /api/status
import get from './get.mjs';
import httpsGet from './https-wrapper.mjs';

const statusUrl = 'https://overpass-api.de/api/status';
// const statusUrl = 'http://3.82.244.102/api/status';
const MAX_QUERIES = 22;

// queue information
let timeout = null;
const queue = [];

// add an item to the queue
const enQueue = (...args) => new Promise((resolve, reject) => {
	// add the arguments to the queue with the callbacks
	queue.push({
		args,
		resolve,
		reject,
	});
	// if there's no timeout active then immediately try to send the query
	if (timeout === null && queue.length === 1) {
		testQueue();
	}
});

const testQueue = async () => {
	// if there's nothing in the queue return immediately
	if (queue.length === 0) return;

	// get the status of the api
	const apiStatus = await status();

	// use available slots
	if (apiStatus.slots === -1) {
		apiStatus.slots = MAX_QUERIES - apiStatus.running;
	}
	const loopEnd = Math.min(queue.length, apiStatus.slots);
	for (let i = 0; i < loopEnd; i += 1) {
		deQueue();
	}
	console.log(`Queue length: ${queue.length}`);
	// figure out the next timestamp if there's something in the queue
	if (queue.length > 0 && !timeout) {
		// if an "after" time was supplied run again after that time + 5 seconds
		if (isDate(apiStatus.after)) {
			timeout = setTimeout(testQueueCallback, (apiStatus.after - (new Date())) + 5000);
			console.log(`Waiting until: ${apiStatus.after}`);
		} else {
			// default 30 second timeout
			timeout = setTimeout(testQueueCallback, 3000);
		}
	}
};

// callback for testqueue that clears the timeout handle
const testQueueCallback = () => {
	if (timeout) clearTimeout(timeout);
	timeout = null;
	testQueue();
};

// remvoe an item from the queue and get the response
// a promise is used so we can ensure an item is removed from the queue before returning
const deQueue = () => {
	// get the item from the queue
	const item = queue.shift();
	return new Promise((res, rej) => {
		// get the data
		get(...item.args).then((data) => {
			// resolve this promise and the original one
			res(data);
			item.resolve(data);
		}).catch((e) => {
			// reject this promise and the original one
			rej(e);
			item.reject(e);
		}).finally(() => {
			// short circuit the timer, a slot may have just opened up
			testQueueCallback();
		});
	});
};

const status = async () => {
	const result = await httpsGet(statusUrl, { method: 'GET' });
	// parse the date
	const after = new Date(result.match(/after: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z), /)?.[1]);
	const running = result.match(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/g);
	return {
		slots: +(result.match(/(\d*) slots? available now/)?.[1] ?? -1),
		after: isDate(after) ? after : false,
		running: (running?.length ?? 1) - 1,
	};
};

const isDate = (d) => d instanceof Date && !Number.isNaN(d);

export default enQueue;
