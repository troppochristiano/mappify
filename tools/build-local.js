// Assembles the double-clickable bundle on this machine: `npm run bundle`.
//
// Same shape the release workflow produces, without tagging anything or waiting
// on CI — for the times you need to check the *packaged* app rather than the dev
// server, which is a different program in three ways that matter: it serves the
// built front end instead of Vite, it reads the origin index from a file beside
// the app instead of Turso, and it is started by the launcher rather than by
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
const OUT = path.join(ROOT, 'out', 'Mappify');
const WINDOWS = process.platform === 'win32';

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
fs.mkdirSync(OUT, { recursive: true });

step('Copying the app');
for (const entry of ['server', 'tools', 'package.json', 'README.md']) {
  const from = path.join(ROOT, entry);
  if (fs.existsSync(from)) copyDir(from, path.join(OUT, entry));
}
fs.mkdirSync(path.join(OUT, 'web'), { recursive: true });
copyDir(path.join(ROOT, 'web', 'dist'), path.join(OUT, 'web', 'dist'));
if (fs.existsSync(path.join(ROOT, 'node_modules'))) {
  copyDir(path.join(ROOT, 'node_modules'), path.join(OUT, 'node_modules'));
}

step('Copying the runtime');
// The launcher looks for runtime/node.exe first and falls back to PATH; a
// bundle without one is still testable, it just is not what people download.
if (WINDOWS) {
  fs.mkdirSync(path.join(OUT, 'runtime'), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(OUT, 'runtime', 'node.exe'));
} else {
  fs.mkdirSync(path.join(OUT, 'runtime', 'bin'), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(OUT, 'runtime', 'bin', 'node'));
  fs.chmodSync(path.join(OUT, 'runtime', 'bin', 'node'), 0o755);
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
  fs.copyFileSync(index, path.join(OUT, 'index.db'));
  note(`${path.relative(ROOT, index)} — ${Math.round(fs.statSync(index).size / 1e6)} MB`);
} else {
  note('none found — imports will fall back to MusicBrainz at one request per second.');
  note('Build one with:  node tools/build-bundle-index.js');
}

step('Building the launcher');
// Warns rather than fails: the launcher is packaging, and everything worth
// testing about the bundle is reachable without it. Building it needs the MSVC
// toolchain, which is a Visual Studio install rather than something npm can
// fetch — and inside Git Bash the GNU `link` from coreutils shadows MSVC's
// link.exe, so a machine that *has* the toolchain still fails here and succeeds
// from PowerShell. Not a reason to withhold a bundle.
let launcher = false;
if (WINDOWS) {
  launcher = tryRun('cargo', [
    'build',
    '--release',
    '--manifest-path',
    path.join(ROOT, 'launcher', 'Cargo.toml'),
  ]);
  if (launcher) {
    fs.copyFileSync(
      path.join(ROOT, 'launcher', 'target', 'release', 'Mappify.exe'),
      path.join(OUT, 'Mappify.exe')
    );
  } else {
    note('');
    note('cargo could not build it — the bundle is complete apart from Mappify.exe.');
    note('Start it the way the release notes tell people to when Windows blocks the');
    note('launcher, which runs exactly the same code:');
    note('');
    note('  cd out\\Mappify && runtime\\node.exe tools\\start.js');
  }
} else {
  fs.copyFileSync(path.join(ROOT, 'Mappify.command'), path.join(OUT, 'Mappify.command'));
  fs.chmodSync(path.join(OUT, 'Mappify.command'), 0o755);
}

// ---------------------------------------------------------------------------

step('Done');
note(OUT);
if (!WINDOWS) note('Right-click Mappify.command → Open');
else if (launcher) note('Double-click Mappify.exe');
else note(String.raw`runtime\node.exe tools\start.js   (this build has no launcher)`);
console.log(
  '\n  This bundle keeps its library in the per-user data directory, not in the\n' +
    '  checkout — so it is the installed app you are testing, tokens and all, and\n' +
    '  it will not touch data/ next to the source.\n'
);
