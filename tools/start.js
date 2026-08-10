// `npm start` — the whole application, one process, one port.
//
// `npm run dev` runs two servers and a proxy, which is right while writing code
// and wrong for someone who just wants to look at their music. This builds the
// web app if it needs building, starts the server, and opens a browser at it.
//
// The redirect URI stays http://127.0.0.1:8787/api/auth/callback, which Spotify
// accepts precisely because it is loopback — that exemption is the whole reason
// running this on your own machine needs no domain, no certificate and no
// hosting.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../server/env.js';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const DIST = path.join(ROOT, 'web', 'dist');
const PORT = Number(process.env.MAPPIFY_PORT ?? 8787);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const run = (cmd, args, cwd) => {
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) process.exit(res.status ?? 1);
};

/**
 * Rebuild when any source file is newer than the bundle.
 *
 * Cheaper than always building — a rebuild is a few seconds and startup should
 * not cost that every time — and safer than never building, which is how you end
 * up staring at a fixed version of the app wondering why an edit did nothing.
 */
function needsBuild() {
  const index = path.join(DIST, 'index.html');
  if (!fs.existsSync(index)) return true;
  const built = fs.statSync(index).mtimeMs;
  const newest = (dir) => {
    let max = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      max = Math.max(max, entry.isDirectory() ? newest(full) : fs.statSync(full).mtimeMs);
    }
    return max;
  };
  return newest(path.join(ROOT, 'web', 'src')) > built;
}

if (!fs.existsSync(path.join(ROOT, 'web', 'node_modules'))) {
  console.log('Installing (once) …');
  run(npm, ['install', '--prefix', path.join(ROOT, 'web'), '--silent'], ROOT);
}
if (needsBuild()) {
  console.log('Building …');
  run(npm, ['run', 'build', '--prefix', path.join(ROOT, 'web'), '--silent'], ROOT);
}

const url = process.env.MAPPIFY_PUBLIC_URL ?? `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'api.js')], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, MAPPIFY_PORT: String(PORT) },
});
server.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill());

// A short wait rather than polling the port: the server is listening within
// milliseconds, and a browser that opens fractionally early just retries.
setTimeout(() => {
  console.log(`\n  Mappify is at ${url}\n`);
  const open =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    spawn(open[0], open[1], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* the URL is printed above either way */
  }
}, 700);
