import fs from 'node:fs/promises';
import sharp from 'sharp';

// slice an image into tileWidth x tileHeight tiles, written as
// lossless, maximum-effort ./{outputDir}/{xx}-{yy}.webp where xx is the column (west to east)
// and yy is the row (north to south), both zero-padded to 2 digits
const sliceToTiles = async (source, outputDir, tileWidth, tileHeight) => {
	await fs.mkdir(outputDir, { recursive: true });

	const image = sharp(source);
	const { width, height } = await image.metadata();

	const columns = Math.ceil(width / tileWidth);
	const rows = Math.ceil(height / tileHeight);

	const jobs = [];
	for (let x = 0; x < columns; x += 1) {
		for (let y = 0; y < rows; y += 1) {
			const left = x * tileWidth;
			const top = y * tileHeight;
			const extractWidth = Math.min(tileWidth, width - left);
			const extractHeight = Math.min(tileHeight, height - top);

			const xx = String(x).padStart(2, '0');
			const yy = String(y).padStart(2, '0');
			const fileName = `${outputDir}/${xx}-${yy}.webp`;

			jobs.push(
				sharp(source)
					.extract({
						left, top, width: extractWidth, height: extractHeight,
					})
					.webp({ lossless: true, effort: 6 })
					.toFile(fileName),
			);
		}
	}

	await Promise.all(jobs);
};

export default sliceToTiles;
