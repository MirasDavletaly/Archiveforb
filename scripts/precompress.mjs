// Run once when the image is built: writes .br and .gz copies of the site's scripts, styles and the PDF viewer, so
// the server sends ~3x less (the viewer goes from 6.5 MB to about 2 MB) without compressing on every request.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT } from '../src/config.mjs';

const dirs = ['public', 'public/vendor/embedpdf-2.15.1', 'public/vendor/tus-js-client-4.3.1'];
let before = 0, after = 0;
for (const dir of dirs) {
  for (const name of fs.readdirSync(path.join(ROOT, dir))) {
    if (!/\.(js|css|html|wasm|svg)$/.test(name)) continue;
    const file = path.join(ROOT, dir, name);
    const raw = fs.readFileSync(file);
    const br = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
    fs.writeFileSync(`${file}.br`, br);
    fs.writeFileSync(`${file}.gz`, zlib.gzipSync(raw, { level: 9 }));
    before += raw.length;
    after += br.length;
  }
}
console.log(`precompressed: ${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB (brotli)`);
