// `npm start` — the whole application, one process, one port.
//
// `npm run dev` runs two servers and a proxy, which is right while writing code
// and wrong for someone who just wants to look at their music. This builds the
// web app if it needs building, starts the server, and opens a browser at it.
//
// The redirect URI stays http://127.0.0.1:6942/api/auth/callback, which Spotify
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
const PORT = Number(process.env.MAPPIFY_PORT ?? 6942);
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

/**
 * A Chromium that can open a window with no tab strip and no address bar.
 *
 * `--app=` is the whole trick: the same browser you already have, minus the
 * browser. It gets its own taskbar entry and its own icon, and looks like an
 * application rather than a page.
 *
 * Deliberately the normal profile, not a private one: the session cookie and
 * whatever Spotify login you already have live there, so it opens signed in and
 * the embedded player can play full tracks. A separate profile would look
 * identical and ask you to sign into everything again.
 */
function findAppBrowser() {
  const candidates =
    process.platform === 'win32'
      ? [
          `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];

  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

const openBrowser = () => {
  const app = findAppBrowser();
  try {
    if (app) {
      spawn(app, [`--app=${url}`, '--window-size=1280,820'], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      return;
    }
    // No Chromium anywhere — a tab in whatever they use is still the app.
    const open =
      process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
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
