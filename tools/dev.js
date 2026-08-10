// One command to run both halves: `npm run dev`.
//
// A self-hoster should not need to know that Mappify is two processes, or which
// port each one wants. Ctrl+C stops both.

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import '../server/env.js';
import { reportConfig } from '../server/env.js';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');

if (!fs.existsSync(path.join(ROOT, '.env'))) {
  console.log('No .env yet — copy .env.example to .env and fill it in.\n');
}
reportConfig();

if (!fs.existsSync(path.join(ROOT, 'web', 'node_modules'))) {
  console.error('\nweb/node_modules is missing. Run:  npm install --prefix web');
  process.exit(1);
}

const children = [];
const start = (name, command, args, cwd, env = process.env) => {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Only npm needs it, because it is a .cmd shim on Windows and cmd is what
    // knows how to run one. Never for node: with shell:true the arguments are
    // concatenated unquoted, so a default install path splits at the space and
    // the child dies on "C:\Program is not recognised".
    shell: process.platform === 'win32' && command === 'npm',
  });
  const tag = (line) => `[${name}] ${line}`;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of chunk.split('\n')) {
        // The experimental-SQLite warning fires on every process start and says
        // nothing useful to someone just running the app.
        if (!line.trim() || line.includes('ExperimentalWarning') || line.includes('--trace-warnings')) continue;
        console.log(tag(line));
      }
    });
  }
  child.on('exit', (code) => {
    console.log(tag(`exited (${code})`));
    stopAll();
  });
  children.push(child);
  return child;
};

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill();
  process.exit(0);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

/**
 * The first free port at or above `from`.
 *
 * A second copy of Mappify on one machine — another branch, another agent —
 * otherwise dies on EADDRINUSE for a port it does not actually care about. An
 * explicit MAPPIFY_PORT is never overridden, because someone who names a port
 * usually needs that exact one.
 */
async function freePort(from) {
  const net = await import('node:net');
  for (let port = from; port < from + 20; port++) {
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  throw new Error(`No free port between ${from} and ${from + 20}`);
}

const DEFAULT_API = 6942;
const apiPort = process.env.MAPPIFY_PORT
  ? Number(process.env.MAPPIFY_PORT)
  : await freePort(DEFAULT_API);
const webPort = Number(process.env.PORT ?? 5273);

const env = {
  ...process.env,
  MAPPIFY_PORT: String(apiPort),
  // The proxy has to point at the API we actually started, not the default.
  VITE_API_TARGET: `http://127.0.0.1:${apiPort}`,
  PORT: String(webPort),
  // In development the app is Vite's, not ours — the API only serves it in
  // production, so it has to be told where to send someone after a sign-in.
  MAPPIFY_WEB: process.env.MAPPIFY_WEB ?? `http://localhost:${webPort}`,
  // The API exiting on its own would take this whole pair down — stopAll() kills
  // Vite when a child dies. In development you stop it with Ctrl-C.
  MAPPIFY_AUTOQUIT: '0',
};

start('api', process.execPath, [path.join(ROOT, 'server', 'api.js')], ROOT, env);
start('web', 'npm', ['run', 'dev'], path.join(ROOT, 'web'), env);

console.log(`\n  api  http://127.0.0.1:${apiPort}`);
console.log(`  app  http://localhost:${webPort}\n`);

// The redirect URI registered with Spotify names a port. On any other one the
// sign-in will be refused by Spotify rather than by this code, so say it here
// rather than leaving it to be discovered at the end of the flow.
if (apiPort !== DEFAULT_API) {
  console.log(
    `  note: the api is on ${apiPort}, not ${DEFAULT_API}, so Spotify sign-in will be\n` +
      `  refused unless http://127.0.0.1:${apiPort}/api/auth/callback is also registered\n` +
      `  in your app at developer.spotify.com.\n`
  );
}
