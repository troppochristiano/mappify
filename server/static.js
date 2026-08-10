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
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

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
