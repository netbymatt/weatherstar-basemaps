// crop an image provided as a canvas
// start at x,y
// end at x+dx, y+dy
// return as a canvas

import { createCanvas } from 'canvas';

const crop = (origCanvas, process) => {
	// new canvas
	const canvas = createCanvas(process.dx, process.dy);
	const ctx = canvas.getContext('2d', { pixelFormat: 'A8' });

	// copy image
	ctx.drawImage(origCanvas, process.x, process.y, process.dx, process.dy, 0, 0, process.dx, process.dy);

	// convert to buffer
	return canvas;
};

export default crop;
