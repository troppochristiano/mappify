// The Windows icon, built from the same SVG the browser uses: `node tools/build-icon.js`.
//
// Windows will not take an SVG. The shortcut in a download needs a real .ico, and
// an .ico is a container of several square images at fixed sizes — Explorer picks
// the one nearest what it is drawing, and scales badly when it has to invent it.
// So every size the shell asks for is rendered from the vector rather than
// resampled from one bitmap.
//
// Written by hand rather than with a package, because the container is a
// six-byte header, a sixteen-byte row per image, and then the images: every
// Windows since Vista reads PNG payloads inside an .ico, which is what makes the
// 256 affordable at all. A dependency for forty lines of DataView is a
// dependency to audit and update forever.
//
// Not part of `npm run bundle` — an icon changes when the artwork does, which is
// rarely, and rendering seven PNGs on every build to get a file that did not
// change would be paying for it every time. Run this when favicon.svg changes
// and commit the result.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const SRC = path.join(ROOT, 'web', 'public', 'favicon.svg');
const OUT = path.join(ROOT, 'web', 'public', 'favicon.ico');

/**
 * 16 through 256.
 *
 * 16 and 32 are the list and taskbar, 48 is Explorer's medium icons, 256 is the
 * one the large-icon views and the Alt-Tab switcher reach for. The middle sizes
 * cost a few kilobytes each and stop the shell interpolating between two that
 * are far apart.
 */
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// Rendered from the vector at each size, not resized from one big raster: a
// continent outline thinned by a bilinear downscale to 16px turns to mush.
const images = [];
for (const size of SIZES) {
  images.push({ size, png: await sharp(SRC, { density: 384 }).resize(size, size).png().toBuffer() });
}

const HEADER = 6;
const ENTRY = 16;
const dir = Buffer.alloc(HEADER + ENTRY * images.length);
dir.writeUInt16LE(0, 0); // reserved
dir.writeUInt16LE(1, 2); // 1 = icon, 2 would be a cursor
dir.writeUInt16LE(images.length, 4);

let offset = dir.length;
images.forEach(({ size, png }, i) => {
  const at = HEADER + ENTRY * i;
  // 256 is written as 0: the field is one byte, so the largest size an icon may
  // have is the one value it cannot hold.
  dir.writeUInt8(size === 256 ? 0 : size, at);
  dir.writeUInt8(size === 256 ? 0 : size, at + 1);
  dir.writeUInt8(0, at + 2); // palette size, 0 for truecolour
  dir.writeUInt8(0, at + 3); // reserved
  dir.writeUInt16LE(1, at + 4); // colour planes
  dir.writeUInt16LE(32, at + 6); // bits per pixel
  dir.writeUInt32LE(png.length, at + 8);
  dir.writeUInt32LE(offset, at + 12);
  offset += png.length;
});

fs.writeFileSync(OUT, Buffer.concat([dir, ...images.map((i) => i.png)]));
console.log(
  `${path.relative(ROOT, OUT)} — ${SIZES.join(', ')} — ${Math.round(fs.statSync(OUT).size / 1024)} KB`
);

// ---------------------------------------------------------------------------

/**
 * The macOS icon, from the same source.
 *
 * An .icns is the same idea as the .ico in a different container: a magic word,
 * a total length, then one typed chunk per image. The four-letter types are the
 * sizes — ic11 is 16pt at 2x, ic12 is 32pt at 2x, and so on up to ic10, which is
 * the 1024 the Finder uses for a large preview. Retina means every size worth
 * shipping is even, so the small odd ones the format also allows are left out.
 *
 * It lands in assets/ rather than web/public/ because nothing serves it: a
 * browser has no use for an .icns, and web/public is copied wholesale into
 * web/dist and shipped to every platform. The .ico earns its place there by
 * doubling as /favicon.ico.
 */
const ICNS_TYPES = [
  ['ic11', 32],   // 16pt @2x — the menu bar and list views
  ['ic12', 64],   // 32pt @2x
  ['ic07', 128],
  ['ic13', 256],  // 128pt @2x
  ['ic08', 256],
  ['ic14', 512],  // 256pt @2x
  ['ic09', 512],
  ['ic10', 1024], // 512pt @2x — Finder's largest
];

const ICNS_OUT = path.join(ROOT, 'assets', 'Mappify.icns');
const chunks = [];
for (const [type, size] of ICNS_TYPES) {
  const png = await sharp(SRC, { density: 384 }).resize(size, size).png().toBuffer();
  const head = Buffer.alloc(8);
  head.write(type, 0, 'ascii');
  // Length counts the eight bytes of the header itself, which is the one thing
  // in this format that is easy to get wrong and impossible to see afterwards.
  head.writeUInt32BE(png.length + 8, 4);
  chunks.push(head, png);
}
const body = Buffer.concat(chunks);
const icns = Buffer.alloc(8);
icns.write('icns', 0, 'ascii');
icns.writeUInt32BE(body.length + 8, 4);
fs.mkdirSync(path.dirname(ICNS_OUT), { recursive: true });
fs.writeFileSync(ICNS_OUT, Buffer.concat([icns, body]));
console.log(
  `${path.relative(ROOT, ICNS_OUT)} — ${ICNS_TYPES.map(([, s]) => s).join(', ')} — ${Math.round(
    fs.statSync(ICNS_OUT).size / 1024
  )} KB`
);
