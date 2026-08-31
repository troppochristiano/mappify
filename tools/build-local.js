// Assembles the double-clickable bundle on this machine: `npm run bundle`.
//
// Same shape the release workflow produces, without tagging anything or waiting
// on CI — for the times you need to check the *packaged* app rather than the dev
// server, which is a different program in three ways that matter: it serves the
// built front end instead of Vite, it reads the origin index from a file beside
// the app instead of Turso, and it is started by the shortcut rather than by
// npm. Bugs live in all three gaps.
//
// This is deliberately not a second implementation of the release. It builds for
// the machine it runs on and nothing else, because the reason CI uses three
// runners is that npm only resolves platform-specific optional dependencies on
// the platform it is installing for — a Windows bundle made here would fail on a
// Mac on first launch. .github/workflows/release.yml stays the thing that cuts
// releases; this is for looking at one.
//
// Two honest differences from a release build:
//
//   - node_modules is copied as it is, so the local bundle carries devDeps that
//     the released one does not. It is fatter, not different.
//   - the runtime is the node running this script, rather than a fresh download
//     of the version pinned in the workflow. Worth a glance if you are chasing
//     something version-shaped.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const WINDOWS = process.platform === 'win32';
const MAC = process.platform === 'darwin';

/**
 * What gets packaged, and where the app itself sits inside it.
 *
 * On macOS these are two different places. An .app is a folder the Finder treats
 * as a single object, and dragging it to Applications moves only what is inside
 * it — so a payload sitting *beside* the bundle would be left behind, and the
 * app would work once and never again. Everything therefore lives in
 * Contents/Resources/app, and the launcher inside the bundle walks down to it.
 *
 * Everywhere else the two are the same folder, which is the layout that has
 * always shipped: a directory of parts with a launcher among them.
 */
const OUT = MAC ? path.join(ROOT, 'out', 'Mappify.app') : path.join(ROOT, 'out', 'Mappify');
const APP = MAC ? path.join(OUT, 'Contents', 'Resources', 'app') : OUT;

const step = (msg) => console.log(`\n\x1b[1m${msg}\x1b[0m`);
const note = (msg) => console.log(`  ${msg}`);

function tryRun(command, args, cwd = ROOT) {
  // shell only for npm and cargo, which are .cmd shims on Windows. Never for a
  // bare executable path: with shell:true the arguments are concatenated
  // unquoted and a default install path splits at its space.
  const res = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: WINDOWS && (command === 'npm' || command === 'cargo'),
  });
  return res.status === 0;
}

function run(command, args, cwd = ROOT) {
  if (!tryRun(command, args, cwd)) {
    console.error(`\n${command} ${args.join(' ')} failed`);
    process.exit(1);
  }
}

const copyDir = (from, to) => fs.cpSync(from, to, { recursive: true });

// ---------------------------------------------------------------------------

step('Building the web app');
run('npm', ['run', 'build']);

step('Clearing out/');
fs.rmSync(path.join(ROOT, 'out'), { recursive: true, force: true });
fs.mkdirSync(APP, { recursive: true });

step('Copying the app');
for (const entry of ['server', 'tools', 'package.json', 'README.md']) {
  const from = path.join(ROOT, entry);
  if (fs.existsSync(from)) copyDir(from, path.join(APP, entry));
}
fs.mkdirSync(path.join(APP, 'web'), { recursive: true });
copyDir(path.join(ROOT, 'web', 'dist'), path.join(APP, 'web', 'dist'));
if (fs.existsSync(path.join(ROOT, 'node_modules'))) {
  copyDir(path.join(ROOT, 'node_modules'), path.join(APP, 'node_modules'));
}

step('Copying the runtime');
// The shortcut points straight at runtime/node.exe, so a bundle without one has
// nothing to double-click — still testable by running start.js, but not what
// people download.
if (WINDOWS) {
  fs.mkdirSync(path.join(APP, 'runtime'), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(APP, 'runtime', 'node.exe'));
} else {
  fs.mkdirSync(path.join(APP, 'runtime', 'bin'), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(APP, 'runtime', 'bin', 'node'));
  fs.chmodSync(path.join(APP, 'runtime', 'bin', 'node'), 0o755);
}
note(`node ${process.version}`);

step('Copying the origin index');
// Where server/mbindex.js looks in a download: index.db beside the app. Anything
// already built locally will do — the point of testing the bundle is to exercise
// the file path rather than Turso, and any index proves that.
const index = ['data/index.db', '.mbdump/mb-index.db']
  .map((p) => path.join(ROOT, p))
  .find((p) => fs.existsSync(p));
if (index) {
  fs.copyFileSync(index, path.join(APP, 'index.db'));
  note(`${path.relative(ROOT, index)} — ${Math.round(fs.statSync(index).size / 1e6)} MB`);
} else {
  note('none found — imports will fall back to MusicBrainz at one request per second.');
  note('Build one with:  node tools/build-bundle-index.js');
}

step('Copying the icon');
// Windows cannot take the SVG the browser uses, and neither a .lnk nor a desktop
// entry can point inside web/dist and be understood — so the icon travels beside
// the launcher in the form each platform reads. Built by tools/build-icon.js and
// committed; missing only if it was never made.
//
// macOS gets neither: a .command is a plain script, and Finder will not draw an
// icon for one without a .app bundle around it.
const ico = path.join(ROOT, 'web', 'public', 'favicon.ico');
const png = path.join(ROOT, 'web', 'public', 'icon-512.png');
const icns = path.join(ROOT, 'assets', 'Mappify.icns');
const source = WINDOWS ? ico : MAC ? icns : png;
const shipIcon = fs.existsSync(source);
if (!shipIcon) {
  note(`${path.relative(ROOT, source)} is missing — the launcher will use a generic icon.`);
  note('Build it with:  node tools/build-icon.js');
} else if (WINDOWS) {
  // In a subfolder, not beside the launcher. What someone sees on unzipping
  // should be one obvious thing to open; an icon file sitting next to the
  // shortcut, with the same name and a similar picture, is a second thing that
  // looks equally openable and does nothing.
  fs.mkdirSync(path.join(OUT, 'resources'), { recursive: true });
  fs.copyFileSync(ico, path.join(OUT, 'resources', 'Mappify.ico'));
  note('resources/Mappify.ico');
} else if (MAC) {
  // Named to match CFBundleIconFile, which is what the Finder looks up.
  const res = path.join(OUT, 'Contents', 'Resources');
  fs.mkdirSync(res, { recursive: true });
  fs.copyFileSync(icns, path.join(res, 'Mappify.icns'));
  note('Contents/Resources/Mappify.icns');
} else {
  fs.mkdirSync(path.join(OUT, 'resources'), { recursive: true });
  fs.copyFileSync(png, path.join(OUT, 'resources', 'Mappify.png'));
  note('resources/Mappify.png');
}

step(MAC ? 'Making the app bundle' : 'Making the shortcut');
// A .lnk to the Node beside it, not a launcher of our own: Defender's ML model
// began blocking the Rust one as Wacatac!ml with no way through, and a build
// containing no unsigned binary of ours has nothing to block. See
// tools/make-shortcut.ps1 for why the relative path is the load-bearing part.
//
// Warns rather than fails, as the cargo build it replaces did: everything worth
// testing about a bundle is reachable by running start.js directly.
let shortcut = false;
if (WINDOWS) {
  shortcut = tryRun('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(ROOT, 'tools', 'make-shortcut.ps1'),
    '-Lnk',
    path.join(OUT, 'Mappify.lnk'),
    '-Target',
    path.join(OUT, 'runtime', 'node.exe'),
    '-Arguments',
    'tools\\start.js',
    '-WorkDir',
    OUT,
    ...(shipIcon ? ['-Icon', path.join(OUT, 'resources', 'Mappify.ico')] : []),
    '-Description',
    'Mappify — a globe of your music',
    '-ShowCmd',
    '7',
  ]);
  if (!shortcut) {
    note('');
    note('the shortcut could not be written — the bundle is complete apart from it.');
    note('Start it the way the shortcut would, which runs exactly the same code:');
    note('');
    note('  cd out\\Mappify && runtime\\node.exe tools\\start.js');
  }
} else if (MAC) {
  // Info.plist and the launcher script are kept as real files under mac/ rather
  // than written from here, so the thing that ships is the thing you can read —
  // and so this build and the release workflow cannot drift apart by editing one
  // heredoc and not the other.
  const template = path.join(ROOT, 'mac', 'Mappify.app', 'Contents');
  copyDir(path.join(template, 'MacOS'), path.join(OUT, 'Contents', 'MacOS'));
  // The exec bit does not always survive a checkout on every platform, and a
  // bundle whose executable is not executable fails with "the application can
  // not be opened" and no reason given.
  fs.chmodSync(path.join(OUT, 'Contents', 'MacOS', 'Mappify'), 0o755);
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  fs.writeFileSync(
    path.join(OUT, 'Contents', 'Info.plist'),
    fs.readFileSync(path.join(template, 'Info.plist'), 'utf8').replaceAll('__VERSION__', version)
  );
  note(`Mappify.app — version ${version}`);
} else {
  fs.copyFileSync(path.join(ROOT, 'Mappify.command'), path.join(OUT, 'Mappify.command'));
  fs.chmodSync(path.join(OUT, 'Mappify.command'), 0o755);
  // Linux file managers want a desktop entry, and will not offer to run one that
  // is not executable.
  fs.copyFileSync(path.join(ROOT, 'Mappify.desktop'), path.join(OUT, 'Mappify.desktop'));
  fs.chmodSync(path.join(OUT, 'Mappify.desktop'), 0o755);
}

// ---------------------------------------------------------------------------

step('Done');
note(OUT);
if (MAC) note('Right-click Mappify.app → Open (once — Gatekeeper)');
else if (!WINDOWS) note('Right-click Mappify.command → Open');
else if (shortcut) note('Double-click Mappify');
else note(String.raw`runtime\node.exe tools\start.js   (this build has no shortcut)`);
console.log(
  '\n  This bundle keeps its library in the per-user data directory, not in the\n' +
    '  checkout — so it is the installed app you are testing, tokens and all, and\n' +
    '  it will not touch data/ next to the source.\n'
);
