// Loads .env before anything reads process.env.
//
// Node has had process.loadEnvFile() built in since 20.6, so this needs no
// dependency — and every entry point imports it first so a self-hoster only ever
// edits one file.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const ENV_FILE = path.join(ROOT, '.env');

if (fs.existsSync(ENV_FILE)) {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch (err) {
    console.warn(`Could not read .env: ${err.message}`);
  }
}

export const config = {
  clientId: process.env.SPOTIFY_CLIENT_ID?.trim() ?? null,
  mbContact: process.env.MB_CONTACT?.trim() ?? null,
  indexUrl: process.env.MAPPIFY_INDEX_URL?.trim() ?? null,
  indexToken: process.env.MAPPIFY_INDEX_TOKEN?.trim() ?? null,
};

/** Warns rather than throws: the app is still useful without every key. */
export function reportConfig() {
  const missing = [];
  if (!config.clientId) missing.push('SPOTIFY_CLIENT_ID (no import or playlist creation)');
  if (!config.mbContact) missing.push('MB_CONTACT (MusicBrainz fallback lookups will refuse to run)');
  if (missing.length) {
    console.log('Config notes:');
    for (const m of missing) console.log(`  - missing ${m}`);
    console.log('  See .env.example');
  }
}
