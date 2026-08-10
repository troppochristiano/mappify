/**
 * Build the index that ships inside the download.
 *
 * The alternative was a read-only token to a hosted database, published in a
 * public file, that every copy calls out to. This is better on every count: no
 * credential to leak or revoke, no quota anyone can burn, no network on the path
 * that makes an import fast, and the app works on a train. Spotify becomes the
 * only remote thing, which is the point — it is the only one that is genuinely
 * about *you*.
 *
 * It carries everything a first import needs to place artists instantly:
 *
 *   artist_origin        Spotify id -> MusicBrainz id and areas, for every
 *                        artist MusicBrainz knows a Spotify link for
 *   area                 only the areas some artist actually points at, with
 *                        coordinates from Wikidata
 *   place, admin_area    the settlement tree and the containment chain
 *   artist_origin_wiki   scene origins — 2Pac in Baltimore, not East Harlem
 *   artist_place         the tail MusicBrainz has no area for
 *
 * `name` is dropped from artist_origin: the app shows Spotify's own name for an
 * artist, and 435,000 duplicates of it cost about 8 MB.
 *
 *   node tools/build-bundle-index.js [--out data/index.db]
 *
 * Reads .mbdump/mb-index.db (built by tools/build-mb-index.js) and your own
 * library for the derived corrections. Maintainer tool: everyone else gets the
 * result in the zip.
 */
import '../server/env.js';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, openDbForCli, DB_PATH } from '../server/db.js';

const args = process.argv.slice(2);
const oi = args.indexOf('--out');
const OUT = path.resolve(oi >= 0 ? args[oi + 1] : path.join(ROOT, 'data', 'index.db'));
const SOURCE = path.join(ROOT, '.mbdump', 'mb-index.db');

if (!fs.existsSync(SOURCE)) {
  console.log(`No ${SOURCE}. Build it first: node tools/build-mb-index.js --all`);
  process.exit(1);
}

// The library holding the derived corrections. openDbForCli resolves it the same
// way every other tool does, so --user works here too.
const app = openDbForCli();
const appFile = app.prepare('PRAGMA database_list').all().find((r) => r.name === 'main')?.file ?? DB_PATH;
app.close();

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.rmSync(OUT, { force: true });

const db = new DatabaseSync(OUT);
db.exec(`ATTACH '${SOURCE.replace(/\\/g, '/')}' AS src`);
db.exec(`ATTACH '${appFile.replace(/\\/g, '/')}' AS app`);

const has = (table, column) =>
  db.prepare(`SELECT count(*) n FROM pragma_table_info(?) WHERE name = ?`).get(table, column).n > 0;

// area gained admin_parent_qid after some indexes were built, and a bundle
// should be buildable from either. The chain travels in admin_area regardless,
// so its absence here costs nothing.
const areaAdmin = has('src.area', 'admin_parent_qid') ? 'admin_parent_qid' : 'NULL admin_parent_qid';

db.exec(`
  CREATE TABLE artist_origin (
    spotify_id TEXT PRIMARY KEY, mbid TEXT NOT NULL, type TEXT,
    begin_area_id TEXT, area_id TEXT, country_iso TEXT);
  INSERT INTO artist_origin
    SELECT spotify_id, mbid, type, begin_area_id, area_id, country_iso FROM src.artist_origin;

  CREATE TABLE area (
    mb_area_id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT, iso TEXT, wd_qid TEXT,
    lat REAL, lon REAL, is_city INTEGER, parent_qid TEXT, admin_parent_qid TEXT,
    country TEXT, country_iso TEXT);
  INSERT INTO area
    SELECT mb_area_id, name, type, iso, wd_qid, lat, lon, is_city, parent_qid,
           ${areaAdmin}, country, country_iso
      FROM src.area
     WHERE mb_area_id IN (SELECT begin_area_id FROM src.artist_origin
                          UNION SELECT area_id FROM src.artist_origin);

  CREATE TABLE place AS
    SELECT qid, name, country, country_iso, lat, lon, parent_qid, is_city,
           capital_qid, admin_parent_qid
      FROM app.places WHERE qid LIKE 'Q%';

  CREATE TABLE admin_area AS
    SELECT qid, name, admin_parent_qid, capital_qid FROM app.admin_areas
     WHERE qid NOT IN (SELECT qid FROM app.places);

  CREATE TABLE artist_origin_wiki AS
    SELECT DISTINCT mbid, origin_wiki_qid place_qid FROM app.artists
     WHERE origin_wiki_qid IS NOT NULL AND mbid IS NOT NULL AND mbid <> '';

  CREATE TABLE artist_place AS
    SELECT DISTINCT mbid, place_qid FROM app.artists
     WHERE place_qid IS NOT NULL AND mbid IS NOT NULL AND mbid <> '';

  -- Declared rather than copied with CREATE TABLE AS, which would produce a
  -- table with no primary key and nothing for the upsert below to conflict on.
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO meta SELECT key, value FROM src.meta;
`);

// The copied meta describes the source, which claims more artists and far more
// areas than travelled. Correct it, or `index:info` reports a bundle as holding
// 120,049 areas when it holds the 16,641 anyone can reach.
db.exec(`
  INSERT INTO meta (key, value) VALUES
    ('artist_rows', (SELECT count(*) FROM artist_origin)),
    ('area_rows',   (SELECT count(*) FROM area)),
    ('bundled',     'yes')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
`);

db.exec(`
  CREATE INDEX idx_area_wd ON area(wd_qid);
  CREATE UNIQUE INDEX idx_place_qid ON place(qid);
  CREATE UNIQUE INDEX idx_admin_qid ON admin_area(qid);
  CREATE UNIQUE INDEX idx_wiki_mbid ON artist_origin_wiki(mbid);
  CREATE UNIQUE INDEX idx_place_mbid ON artist_place(mbid);
`);

db.exec('DETACH src');
db.exec('DETACH app');
db.exec('VACUUM'); // reclaims what the copies left behind — worth several MB

console.log(`${OUT}\n`);
for (const t of ['artist_origin', 'area', 'place', 'admin_area', 'artist_origin_wiki', 'artist_place']) {
  console.log(`  ${t.padEnd(20)} ${String(db.prepare(`SELECT count(*) n FROM ${t}`).get().n).padStart(7)}`);
}
db.close();
console.log(`\n  ${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB`);
