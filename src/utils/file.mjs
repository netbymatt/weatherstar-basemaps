import fs from 'node:fs';
import sharp from 'sharp';

// write a canvas to a Png file
const writePngToFile = (fileName, canvas, palette) => new Promise((resolve, reject) => {
	const writeStream = fs.createWriteStream(fileName);
	canvas.createPNGStream({ palette }).pipe(writeStream);
	writeStream.on('finish', () => resolve(fileName));
	writeStream.on('error', (e) => reject(e));
});

// write a canvas to a lossless, maximum-effort compressed Webp file
const writeWebpToFile = async (fileName, canvas, palette) => {
	const pngBuffer = canvas.toBuffer('image/png', { palette });
	await sharp(pngBuffer)
		.webp({ lossless: true, effort: 6 })
		.toFile(fileName);
	return fileName;
};

export default writePngToFile;
export { writeWebpToFile };
