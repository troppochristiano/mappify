// Serves the built web app from the same origin as the API.
//
// In development the app is a Vite server on another port that proxies /api
// here, so the browser sees one origin by accident. In production there is no
// proxy, and two origins would mean CORS on every call plus a session cookie
// that needs SameSite=None to survive the trip — which browsers increasingly
// refuse, and which would be a real weakening for no benefit. Serving both from
// one process makes the cookie plainly first-party and removes CORS from the
// picture entirely.
//
// Falls back to index.html for unknown paths, because the client routes
// /artist/:id itself and a browser asking for that URL directly must still get
// the app rather than a 404.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './db.js';

export const WEB_DIST = process.env.MAPPIFY_WEB_DIST ?? path.join(ROOT, 'web', 'dist');

export const hasBuiltApp = () => fs.existsSync(path.join(WEB_DIST, 'index.html'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // Served as octet-stream, a browser ignores the manifest and the window loses
  // its name and icon — which is the entire point of having one.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

/**
 * The image type a buffer actually is, from its leading bytes.
 *
 * Here rather than beside the caller because this file is already the one place
 * that decides what a byte stream is, and the question is the same question —
 * only asked of content rather than of a filename.
 *
 * Deliberately narrower than TYPES above, and the omission that matters is SVG.
 * An avatar arrives inside a file a stranger sent over Discord and ends up in an
 * `<img>` served from this origin; SVG is a document that can carry script, so
 * accepting one would turn "import a friend" into "run their code on my
 * library". The three raster formats Spotify actually serves are the whole list.
 *
 * Sniffed rather than trusted: a `Content-Type` header, or a `mime` field in a
 * hand-written export, is a claim by whoever wrote it. The magic bytes are the
 * file.
 */
export function imageMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/**
 * @returns {boolean} whether the request was answered here
 */
export function serveStatic(req, res, pathname) {
  if (!hasBuiltApp()) return false;

  // Resolve first, then check the result is still inside the directory. Testing
  // the request string for ".." instead is the version that gets bypassed by
  // encoding, and this file is reachable from the open internet.
  const wanted = path.resolve(WEB_DIST, '.' + decodeURIComponent(pathname));
  const inside = wanted === WEB_DIST || wanted.startsWith(WEB_DIST + path.sep);

  let file = inside && fs.existsSync(wanted) && fs.statSync(wanted).isFile() ? wanted : null;
  if (!file) file = path.join(WEB_DIST, 'index.html'); // client-side route

  const ext = path.extname(file);
  // Vite fingerprints everything under /assets, so those can be cached hard.
  // index.html never can, or a deploy is invisible until someone force-reloads.
  const cache =
    ext === '.html'
      ? 'no-cache'
      : file.includes(`${path.sep}assets${path.sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600';

  res.writeHead(200, {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Cache-Control': cache,
  });
  fs.createReadStream(file).pipe(res);
  return true;
}
