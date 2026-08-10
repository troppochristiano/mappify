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
const start = (name, command, args, cwd) => {
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32', // npm is a .cmd shim on Windows
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

start('api', process.execPath, [path.join(ROOT, 'server', 'api.js')], ROOT);
start('web', 'npm', ['run', 'dev'], path.join(ROOT, 'web'));

console.log('\n  api  http://127.0.0.1:8787');
console.log('  app  http://localhost:5273\n');
