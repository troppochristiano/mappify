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
// Only for DATA_DIR, which is where the launcher-icon stamp lives — importing it
// opens no database.
import { DATA_DIR } from '../server/db.js';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const DIST = path.join(ROOT, 'web', 'dist');
const PORT = Number(process.env.MAPPIFY_PORT ?? 6942);

/**
 * How big the app window opens: as large as the screen allows.
 *
 * A globe is the one thing in this app that is better at every extra pixel, and
 * a download that opens in a 1600x1000 box on a 4K display looks like a demo of
 * itself. Maximised rather than true fullscreen (`--start-fullscreen`), which
 * takes the title bar with it — and an app window with no tab strip, no address
 * bar and no title bar has no visible way to close it.
 *
 * Still only a hint: Chrome remembers the bounds of an app window per app URL,
 * so anyone who has opened Mappify before and resized it keeps what they chose.
 * This decides the first launch on a profile.
 *
 * It reaches every platform: the Windows shortcut, Mappify.command and
 * Mappify.desktop all start this file. The no-Chromium fallback further down
 * cannot be sized at all — it hands the URL to whatever browser is default and
 * gets an ordinary tab.
 */
const WINDOW_FLAGS = ['--start-maximized'];
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
      spawn(app, [`--app=${url}`, ...WINDOW_FLAGS], {
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
/**
 * Give the launcher its icon, now that we know where the folder actually is.
 *
 * Both launchers can only name the icon by absolute path — a .lnk stores one and
 * `SetRelativePath` repairs the target and working directory but never the icon,
 * and a desktop entry's `Icon=` takes a path or a theme name and has no
 * equivalent of the `%k` self-location trick `Exec` uses. Either way the path
 * baked in at build time is a CI runner's, so the icon is broken for every
 * person who unzips a release.
 *
 * macOS needs none of this. An .app carries its icon inside itself, at a path
 * relative to the bundle, so it survives being moved by construction — which is
 * most of the argument for shipping one.
 *
 * This file is the only thing that runs from where the folder ended up, so it is
 * the only thing that can say. It rewrites the launcher beside it on first
 * launch and records where it did that, so the cost — one PowerShell for the
 * .lnk — is paid once per location rather than on every start.
 *
 * The stamp lives in the data directory, not next to the app: an installed copy
 * cannot write to its own folder, and a stamp that fails to save would mean
 * doing this again on every launch. If the rewrite itself fails for the same
 * reason, nothing is lost — the launcher keeps whatever icon it had.
 */
function repairLauncherIcon() {
  const stamp = path.join(DATA_DIR, 'launcher-icon-at');
  try {
    if (fs.readFileSync(stamp, 'utf8') === ROOT) return;
  } catch {
    /* never stamped, or unreadable — do the work */
  }

  let done = false;
  if (process.platform === 'win32') {
    const lnk = path.join(ROOT, 'Mappify.lnk');
    const ico = [path.join(ROOT, 'resources', 'Mappify.ico'), path.join(ROOT, 'Mappify.ico')].find(
      (p) => fs.existsSync(p)
    );
    const script = path.join(ROOT, 'tools', 'make-shortcut.ps1');
    if (ico && fs.existsSync(lnk) && fs.existsSync(script)) {
      // Every field is rewritten, not just the icon: this is the same call the
      // build makes, with the paths as they are now, so a folder that moved has
      // its target repaired here too rather than leaning on the shell to do it.
      const res = spawnSync(
        'powershell',
        [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
          '-Lnk', lnk,
          '-Target', path.join(ROOT, 'runtime', 'node.exe'),
          '-Arguments', 'tools\\start.js',
          '-WorkDir', ROOT,
          '-Icon', ico,
          '-Description', 'Mappify — a globe of your music',
          '-ShowCmd', '7',
        ],
        { stdio: 'ignore' }
      );
      done = res.status === 0;
    }
  } else if (process.platform === 'linux') {
    const entry = path.join(ROOT, 'Mappify.desktop');
    const png = [path.join(ROOT, 'resources', 'Mappify.png'), path.join(ROOT, 'Mappify.png')].find(
      (p) => fs.existsSync(p)
    );
    if (png && fs.existsSync(entry)) {
      try {
        const was = fs.readFileSync(entry, 'utf8');
        // Appended under [Desktop Entry] rather than written at a fixed line, so
        // this survives the file being edited, and replaced rather than repeated
        // when it is already there — a second Icon= key makes the entry invalid.
        const now = /^Icon=/m.test(was)
          ? was.replace(/^Icon=.*$/m, `Icon=${png}`)
          : was.replace(/^(\[Desktop Entry\]\n)/, `$1Icon=${png}\n`);
        if (now !== was) fs.writeFileSync(entry, now);
        done = true;
      } catch {
        /* read-only install: it keeps the generic icon, which is what it had */
      }
    }
  }

  if (!done) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(stamp, ROOT);
  } catch {
    /* the work is done either way; this only saves doing it again */
  }
}

repairLauncherIcon();

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
