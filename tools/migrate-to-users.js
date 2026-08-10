/**
 * Move a single-tenant mappify.db into the per-user layout.
 *
 * Before multi-tenancy there was one database at the project root, holding one
 * library and one row of Spotify tokens. Now each account gets
 * `data/u_<spotify id>.db`, and the server picks the file from a session cookie.
 * An existing install has to be told which account the old file belongs to, and
 * the only honest answer comes from Spotify: the tokens already in the file are
 * used to ask who they belong to.
 *
 * The original is **copied, not moved**. It holds a whole listening history and
 * a working refresh token; leaving it in place means a mistake here costs
 * nothing. Delete it yourself once the app comes up with your library in it.
 *
 *   node tools/migrate-to-users.js [--dry-run]
 */
import '../server/env.js';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, DATA_DIR, userDbPath, openControlDb, listUsers } from '../server/db.js';

const dry = process.argv.includes('--dry-run');

if (!fs.existsSync(DB_PATH)) {
  console.log(`No ${DB_PATH} to migrate — nothing to do.`);
  process.exit(0);
}

const existing = listUsers();
if (existing.length) {
  console.log(`data/ already holds ${existing.length} user database(s): ${existing.join(', ')}`);
  console.log('Refusing to migrate on top of them. Move them aside first if this is deliberate.');
  process.exit(1);
}

// Read the token out of the old file directly rather than through openDb(),
// which would apply migrations to a database we are about to copy anyway.
const old = new DatabaseSync(DB_PATH, { readOnly: true });
const auth = old.prepare('SELECT access_token, refresh_token, client_id FROM auth WHERE id = 1').get();
const counts = old.prepare('SELECT (SELECT count(*) FROM tracks) tracks, (SELECT count(*) FROM artists) artists').get();
old.close();

if (!auth?.refresh_token) {
  console.log(
    'That database has no Spotify tokens, so there is no way to tell whose it is.\n' +
      'Sign in through the app instead — it will create a fresh database for you.'
  );
  process.exit(1);
}

/** A fresh access token, since the stored one has almost certainly expired. */
async function accessToken() {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: auth.refresh_token,
      client_id: auth.client_id ?? process.env.SPOTIFY_CLIENT_ID,
    }).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`refresh failed (${res.status}): ${json.error_description ?? json.error ?? ''}`);
  return json.access_token;
}

const res = await fetch('https://api.spotify.com/v1/me', {
  headers: { Authorization: `Bearer ${await accessToken()}` },
});
if (!res.ok) throw new Error(`Spotify profile lookup failed (${res.status})`);
const me = await res.json();

const dest = userDbPath(me.id);
console.log(`${DB_PATH}`);
console.log(`  ${counts.tracks} tracks, ${counts.artists} artists`);
console.log(`  belongs to ${me.display_name ?? me.id} (${me.id})`);
console.log(`  -> ${dest}`);

if (dry) {
  console.log('\n(dry run — nothing copied)');
  process.exit(0);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.copyFileSync(DB_PATH, dest);
// The -wal file holds writes that have not been folded into the main file yet.
// Copying the database without it silently loses the most recent ones.
for (const suffix of ['-wal', '-shm']) {
  if (fs.existsSync(DB_PATH + suffix)) fs.copyFileSync(DB_PATH + suffix, dest + suffix);
}

openControlDb()
  .prepare(
    `INSERT INTO users (spotify_id, display_name, created_at, last_seen_at) VALUES (?,?,?,?)
     ON CONFLICT(spotify_id) DO UPDATE SET display_name = excluded.display_name`
  )
  .run(me.id, me.display_name ?? null, new Date().toISOString(), new Date().toISOString());

console.log('\nCopied. Start the app and sign in with Spotify — you should land on your own map.');
console.log(`The old ${DB_PATH} is untouched; delete it once you are satisfied.`);
console.log('CLI tools now need --user, or MAPPIFY_DB pointing at the new file.');
