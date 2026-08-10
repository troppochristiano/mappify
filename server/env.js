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

/**
 * What MusicBrainz, Wikidata and Wikipedia are told they are talking to.
 *
 * All three ask that a User-Agent identify the application and offer a way to
 * reach whoever is running it. A project URL satisfies that, which is why this
 * has a working default: somebody who downloaded the app and double-clicked it
 * should not have to supply an email address before their library will import.
 *
 * One definition, because three near-identical strings is how two of them end up
 * saying "unknown-contact" to services that asked politely for the opposite.
 */
export function userAgent() {
  return config.mbContact
    ? `mappify/0.1.0 ( ${config.mbContact} )`
    : 'mappify/0.1.0 ( +https://github.com/troppochristiano/mappify )';
}

/** Warns rather than throws: the app is still useful without every key. */
export function reportConfig() {
  const missing = [];
  if (!config.clientId) missing.push('SPOTIFY_CLIENT_ID (or enter it on the setup screen)');
  if (!config.mbContact) missing.push('MB_CONTACT (optional: your address in the User-Agent)');
  if (missing.length) {
    console.log('Config notes:');
    for (const m of missing) console.log(`  - missing ${m}`);
    console.log('  See .env.example');
  }
}
