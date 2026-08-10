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

// A download ships the built app and no sources, and has no npm to build with
// either. Deciding on `web/src` rather than on some flag is what keeps the two
// cases from needing separate launchers: source present means a developer, and
// absent means someone who unzipped this and double-clicked it.
const fromSource = fs.existsSync(path.join(ROOT, 'web', 'src'));

if (fromSource) {
  if (!fs.existsSync(path.join(ROOT, 'web', 'node_modules'))) {
    console.log('Installing (once) …');
    run(npm, ['install', '--prefix', path.join(ROOT, 'web'), '--silent'], ROOT);
  }
  if (needsBuild()) {
    console.log('Building …');
    run(npm, ['run', 'build', '--prefix', path.join(ROOT, 'web'), '--silent'], ROOT);
  }
} else if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(
    '\n  This copy is missing its web/dist folder, so there is nothing to show.\n' +
      '  The download is incomplete — unzip it again, or grab it afresh.\n'
  );
  process.exit(1);
}

const url = process.env.MAPPIFY_PUBLIC_URL ?? `http://127.0.0.1:${PORT}`;

const openBrowser = () => {
  const open =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    spawn(open[0], open[1], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* the URL is printed either way */
  }
};

/**
 * Double-clicking the icon twice should show you Mappify, not an error.
 *
 * The port cannot simply move: it is written into the redirect URI Spotify has
 * on file, so a second copy on another port could not sign anyone in. What a
 * second launch should do is bring up the one already running — and if the port
 * belongs to something else entirely, say so rather than failing on EADDRINUSE
 * with a stack trace nobody outside this repository can read.
 */
const net = await import('node:net');
const portFree = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.once('listening', () => probe.close(() => resolve(true)));
  probe.listen(PORT, '127.0.0.1');
});

if (!portFree) {
  const isMappify = await fetch(`http://127.0.0.1:${PORT}/api/setup`, {
    signal: AbortSignal.timeout(1500),
  })
    .then((r) => r.ok)
    .catch(() => false);

  if (isMappify) {
    console.log(`\n  Mappify is already running at ${url} — opening it.\n`);
    openBrowser();
    process.exit(0);
  }

  console.error(
    `\n  Something else is using port ${PORT}, and Mappify needs that one:\n` +
      `  it is written into the redirect URI Spotify has on file, so moving to\n` +
      `  another port would break signing in.\n\n` +
      `  Close whatever is on ${PORT} and try again.\n`
  );
  process.exit(1);
}

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
  openBrowser();
}, 700);
