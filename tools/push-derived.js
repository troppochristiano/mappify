/**
 * Push the derived corrections into the shared index, so a fresh install gets
 * them without a single API call.
 *
 * Everything so far lives only in one local mappify.db. On someone else's
 * machine Chiswick and Brixton float loose beside London, Amsterdam reads "City
 * unknown", and the Wikipedia-derived origins do not exist at all — 2Pac is back
 * in East Harlem. None of that is anyone's opinion: they are facts about places
 * and artists, identical for every library, and they belong in the index.
 *
 * What travels, and what does not:
 *
 *   place            the settlement tree — coordinates, country, parent_qid,
 *                    is_city, and the admin chain columns
 *   admin_area       the containment skeleton, counties and states included.
 *                    Kept a separate table exactly as it is locally: these are
 *                    not places, nothing renders them, and merging them into
 *                    `place` would nest Bologna under a shell on every install
 *                    that pulled it.
 *   artist_origin_wiki   the scene origins, keyed by MusicBrainz id rather than
 *                    Spotify id, so they apply to any library that has the
 *                    artist at all.
 *
 *   origin_override_qid never travels. A hand-pinned place is an opinion, and
 *   one person's opinion has no business overriding someone else's map.
 *
 * capital_qid matters more than it looks: without P36 a friend's install cannot
 * reproduce the seat rule in fix-artist-scenes.js, and would happily move Snoop
 * Dogg to Los Angeles.
 *
 *   node tools/push-derived.js [--dry-run]
 */
import '../server/env.js';
import { openDb } from '../server/db.js';

const dry = process.argv.includes('--dry-run');

const url = process.env.MAPPIFY_INDEX_URL;
const token = process.env.MAPPIFY_INDEX_TOKEN;
if (!url || !token) {
  console.log('MAPPIFY_INDEX_URL and MAPPIFY_INDEX_TOKEN must be set.');
  process.exit(1);
}

const db = openDb();

const places = db
  .prepare(
    `SELECT qid, name, country, country_iso, lat, lon, parent_qid, is_city,
            capital_qid, admin_parent_qid
       FROM places WHERE qid LIKE 'Q%'`
  )
  .all();

// Only the nodes that are not places in their own right. A place that also has
// a chain row carries its admin_parent_qid in the place table already.
const adminAreas = db
  .prepare(
    `SELECT qid, name, admin_parent_qid, capital_qid FROM admin_areas
      WHERE qid NOT IN (SELECT qid FROM places)`
  )
  .all();

const origins = db
  .prepare(
    `SELECT DISTINCT a.mbid, a.origin_wiki_qid place_qid FROM artists a
      WHERE a.origin_wiki_qid IS NOT NULL AND a.mbid IS NOT NULL AND a.mbid <> ''`
  )
  .all();

// The tail MusicBrainz has no area for at all, resolved through Wikidata's own
// P19/P740 on the artist. Without these an install that pulls everything else
// still files 41 tracks under "City unknown", because nothing in the index is
// keyed by an area they do not have.
const artistPlaces = db
  .prepare(
    `SELECT DISTINCT a.mbid, a.place_qid FROM artists a
      WHERE a.place_qid IS NOT NULL AND a.mbid IS NOT NULL AND a.mbid <> ''`
  )
  .all();

console.log(
  `${places.length} place(s), ${adminAreas.length} chain node(s), ` +
    `${origins.length} scene origin(s), ${artistPlaces.length} area-less artist place(s).`
);
if (dry) {
  console.log('\n(dry run — nothing sent)');
  process.exit(0);
}

const { createClient } = await import('@libsql/client');
const client = createClient({ url, authToken: token });

await client.batch(
  [
    `CREATE TABLE IF NOT EXISTS place (
       qid TEXT PRIMARY KEY, name TEXT NOT NULL, country TEXT, country_iso TEXT,
       lat REAL, lon REAL, parent_qid TEXT, is_city INTEGER,
       capital_qid TEXT, admin_parent_qid TEXT)`,
    `CREATE TABLE IF NOT EXISTS admin_area (
       qid TEXT PRIMARY KEY, name TEXT, admin_parent_qid TEXT, capital_qid TEXT)`,
    `CREATE TABLE IF NOT EXISTS artist_origin_wiki (
       mbid TEXT PRIMARY KEY, place_qid TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS artist_place (
       mbid TEXT PRIMARY KEY, place_qid TEXT NOT NULL)`,
  ],
  'write'
);

const CHUNK = 500;

/** Upsert rather than insert-or-ignore: a re-run has to be able to correct. */
async function send(table, key, cols, rows) {
  const set = cols.filter((c) => c !== key).map((c) => `${c}=excluded.${c}`).join(', ');
  const holes = `(${cols.map(() => '?').join(',')})`;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await client.batch(
      rows.slice(i, i + CHUNK).map((r) => ({
        sql: `INSERT INTO ${table} (${cols.join(',')}) VALUES ${holes}
              ON CONFLICT(${key}) DO UPDATE SET ${set}`,
        args: cols.map((c) => r[c] ?? null),
      })),
      'write'
    );
  }
  console.log(`  ${table}: ${rows.length} rows`);
}

await send(
  'place',
  'qid',
  ['qid', 'name', 'country', 'country_iso', 'lat', 'lon', 'parent_qid', 'is_city', 'capital_qid', 'admin_parent_qid'],
  places
);
await send('admin_area', 'qid', ['qid', 'name', 'admin_parent_qid', 'capital_qid'], adminAreas);
await send('artist_origin_wiki', 'mbid', ['mbid', 'place_qid'], origins);
await send('artist_place', 'mbid', ['mbid', 'place_qid'], artistPlaces);

await client.batch(
  [
    {
      sql: 'INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      args: ['derived_at', new Date().toISOString()],
    },
  ],
  'write'
);
console.log('done');
db.close();
