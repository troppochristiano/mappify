// Builds the shared origin index from MusicBrainz JSON dumps.
//
// Why this exists: resolving an artist's origin through the live MusicBrainz API
// costs two requests at a hard 1 req/s, so a 600-artist library takes ~22
// minutes. The dumps contain the same facts — and the artist records carry
// `relations[]` with `open.spotify.com/artist/...` URLs, so the whole
// Spotify -> MBID -> area chain resolves offline. After this runs, a lookup is a
// single indexed SELECT.
//
// Maintainer tool, not something a self-hoster needs: they point at the hosted
// index instead. Requires `tar` with xz support (`tar -xJ`).
//
//   node tools/build-mb-index.js --artists   # stream artist.tar.xz  (~1.6 GB)
//   node tools/build-mb-index.js --areas     # stream area.tar.xz    (~33 MB)
//   node tools/build-mb-index.js --coords    # Wikidata P982 -> P625 for used areas
//   node tools/build-mb-index.js --push      # upload to Turso
//   node tools/build-mb-index.js --all

import '../server/env.js';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { sparql } from '../server/wikidata.js';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const WORK = process.env.MB_WORK_DIR ?? path.join(ROOT, '.mbdump');
const INDEX_DB = path.join(WORK, 'mb-index.db');
const BASE = 'https://data.metabrainz.org/pub/musicbrainz/data/json-dumps';

const args = process.argv.slice(2);
const want = (flag) => args.includes(flag) || args.includes('--all');

fs.mkdirSync(WORK, { recursive: true });

const db = new DatabaseSync(INDEX_DB);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = OFF;      -- rebuildable from the dumps; speed wins here

CREATE TABLE IF NOT EXISTS artist_origin (
  spotify_id     TEXT PRIMARY KEY,
  mbid           TEXT NOT NULL,
  name           TEXT,
  type           TEXT,          -- Group | Person: changes what begin_area means
  begin_area_id  TEXT,          -- city of formation (group) / of birth (person)
  area_id        TEXT,
  country_iso    TEXT
);
CREATE TABLE IF NOT EXISTS area (
  mb_area_id  TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT,
  iso         TEXT,
  -- Everything below comes from Wikidata, joined on P982. Carrying it here means
  -- the app never makes a SPARQL call: the same hierarchy work the old
  -- server/places.js did at runtime is baked in once, at build time.
  wd_qid      TEXT,
  lat         REAL,
  lon         REAL,
  is_city     INTEGER,      -- P31/P279* -> city. Only meaningful with the child count.
  parent_qid  TEXT,         -- P131, kept only when the parent is a settlement
  -- P131 unfiltered — the county or state parent_qid deliberately throws away.
  -- Carried separately so containment is computable without ever letting a
  -- county into the browse tree. See server/containment.js.
  admin_parent_qid TEXT,
  country     TEXT,
  country_iso TEXT,
  coords_at   TEXT,
  admin_at    TEXT          -- separate stamp: coords_at rows predate the column
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`);
// idx_area_wd is created after the column migration below, not here: on a
// database from an earlier run the column does not exist yet.

// CREATE TABLE IF NOT EXISTS will not add columns to a table built by an earlier
// run, so new fields are applied explicitly — the same idempotent pattern the
// app's own schema uses.
for (const [column, type] of [
  ['wd_qid', 'TEXT'],
  ['is_city', 'INTEGER'],
  ['parent_qid', 'TEXT'],
  ['country', 'TEXT'],
  ['country_iso', 'TEXT'],
  ['admin_parent_qid', 'TEXT'],
  ['admin_at', 'TEXT'],
]) {
  const has = db
    .prepare(`SELECT count(*) n FROM pragma_table_info('area') WHERE name = ?`)
    .get(column).n;
  if (!has) db.exec(`ALTER TABLE area ADD COLUMN ${column} ${type}`);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_area_wd ON area(wd_qid)');

const setMeta = db.prepare('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');

async function latestVersion() {
  const res = await fetch(`${BASE}/LATEST`);
  if (!res.ok) throw new Error(`cannot read LATEST: ${res.status}`);
  return (await res.text()).trim();
}

async function download(version, file) {
  const dest = path.join(WORK, file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`  using cached ${file} (${(fs.statSync(dest).size / 1048576).toFixed(0)} MB)`);
    return dest;
  }
  const url = `${BASE}/${version}/${file}`;
  console.log(`  downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} fetching ${file}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  let seen = 0;
  let lastLog = 0;
  const out = fs.createWriteStream(`${dest}.part`);
  await pipeline(
    async function* () {
      for await (const chunk of res.body) {
        seen += chunk.length;
        if (seen - lastLog > 50 * 1048576) {
          lastLog = seen;
          const pct = total ? ` (${((seen / total) * 100).toFixed(0)}%)` : '';
          console.log(`    ${(seen / 1048576).toFixed(0)} MB${pct}`);
        }
        yield chunk;
      }
    },
    out
  );
  fs.renameSync(`${dest}.part`, dest);
  return dest;
}

/**
 * Streams newline-delimited JSON out of a .tar.xz without ever holding it in
 * memory. The archive also contains COPYING and README ahead of the data, hence
 * the "starts with {" guard.
 */
async function streamRecords(file, onRecord) {
  // --force-local: GNU tar reads "C:\path" as a remote host:path spec and exits 2.
  const tar = spawn('tar', ['--force-local', '-xJOf', file], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  tar.stderr.setEncoding('utf8');
  tar.stderr.on('data', (d) => {
    stderr += d;
  });
  const rl = createInterface({ input: tar.stdout, crlfDelay: Infinity });
  let count = 0;
  for await (const line of rl) {
    if (line.charCodeAt(0) !== 123) continue; // '{'
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    onRecord(rec);
    count++;
  }
  await new Promise((resolve, reject) => {
    tar.on('close', (code) =>
      code === 0 || code === null
        ? resolve()
        : reject(new Error(`tar exited ${code}: ${stderr.trim() || '(no stderr)'}`))
    );
    tar.on('error', reject);
  });
  return count;
}

const SPOTIFY_ARTIST = 'open.spotify.com/artist/';

async function buildArtists(version) {
  console.log('\nArtists');
  const file = await download(version, 'artist.tar.xz');
  const insert = db.prepare(
    `INSERT INTO artist_origin (spotify_id, mbid, name, type, begin_area_id, area_id, country_iso)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(spotify_id) DO UPDATE SET
       mbid=excluded.mbid, name=excluded.name, type=excluded.type,
       begin_area_id=excluded.begin_area_id, area_id=excluded.area_id,
       country_iso=excluded.country_iso`
  );

  let seen = 0;
  let kept = 0;
  db.exec('BEGIN');
  const total = await streamRecords(file, (a) => {
    seen++;
    // The Spotify ID is the lookup key, so an artist without one can never be
    // matched from a Spotify library no matter how good its area data is.
    const rel = (a.relations ?? []).find(
      (r) => r.url?.resource && r.url.resource.includes(SPOTIFY_ARTIST)
    );
    if (!rel) return;
    const spotifyId = rel.url.resource.split(SPOTIFY_ARTIST)[1]?.split(/[?#/]/)[0];
    if (!spotifyId) return;

    insert.run(
      spotifyId,
      a.id,
      a.name ?? null,
      a.type ?? null,
      a['begin-area']?.id ?? null,
      a.area?.id ?? null,
      a.country ?? null
    );
    kept++;
    if (kept % 100000 === 0) {
      db.exec('COMMIT');
      db.exec('BEGIN');
      console.log(`    ${kept} kept of ${seen} scanned`);
    }
  });
  db.exec('COMMIT');
  setMeta.run('artist_rows', String(kept));
  setMeta.run('artist_scanned', String(total));
  console.log(`  ${kept} artists with a Spotify link, from ${total} scanned`);
}

async function buildAreas(version) {
  console.log('\nAreas');
  const file = await download(version, 'area.tar.xz');
  const insert = db.prepare(
    `INSERT INTO area (mb_area_id, name, type, iso) VALUES (?,?,?,?)
     ON CONFLICT(mb_area_id) DO UPDATE SET name=excluded.name, type=excluded.type, iso=excluded.iso`
  );
  let kept = 0;
  db.exec('BEGIN');
  await streamRecords(file, (a) => {
    if (!a.id || !a.name) return;
    insert.run(a.id, a.name, a.type ?? null, a['iso-3166-1-codes']?.[0] ?? null);
    kept++;
  });
  db.exec('COMMIT');
  setMeta.run('area_rows', String(kept));
  console.log(`  ${kept} areas`);
}

/**
 * MusicBrainz has no coordinates. Wikidata does, joined on P982 (MusicBrainz
 * area ID) — an exact join, never a name match: resolving "Los Angeles" by
 * label lands on a point in Texas.
 *
 * Only areas some artist actually points at are worth resolving.
 */
async function buildCoords() {
  console.log('\nCoordinates');
  const todo = db
    .prepare(
      // admin_at, not coords_at: every row resolved before the admin_parent_qid
      // column existed carries a coords_at stamp, so keying off that alone means
      // a schema addition silently never backfills.
      `SELECT mb_area_id FROM area
       WHERE (coords_at IS NULL OR admin_at IS NULL)
         AND mb_area_id IN (
           SELECT begin_area_id FROM artist_origin WHERE begin_area_id IS NOT NULL
           UNION SELECT area_id FROM artist_origin WHERE area_id IS NOT NULL)`
    )
    .all()
    .map((r) => r.mb_area_id);

  console.log(`  ${todo.length} referenced area(s) to resolve`);
  const update = db.prepare(
    `UPDATE area SET wd_qid=?, lat=?, lon=?, is_city=?, parent_qid=?, admin_parent_qid=?,
                     country=?, country_iso=?, coords_at=?, admin_at=?
     WHERE mb_area_id=?`
  );
  const BATCH = 120;
  let filled = 0;

  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const V = batch.map((id) => `"${id}"`).join(' ');
    // Every pattern hangs off a bound subject. Resolving country off a COALESCEd
    // variable instead once matched every P17 statement in Wikidata and returned
    // a 512 MB body — the same trap, avoided the same way.
    const q = `SELECT ?mb ?place ?coord ?isCity ?parent ?adminParent ?countryLabel ?iso WHERE {
      VALUES ?mb { ${V} }
      ?place wdt:P982 ?mb .
      OPTIONAL { ?place wdt:P625 ?coord }
      OPTIONAL { ?place wdt:P17 ?country . OPTIONAL { ?country wdt:P297 ?iso } }
      OPTIONAL { ?place wdt:P131 ?parent . FILTER EXISTS { ?parent wdt:P31/wdt:P279* wd:Q486972 } }
      OPTIONAL { ?place wdt:P131 ?adminParent }
      BIND(EXISTS { ?place wdt:P31/wdt:P279* wd:Q515 } AS ?isCity)
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
    }`;
    const stamp = new Date().toISOString();
    try {
      const json = await sparql(q);
      const found = new Map();
      // Unfiltered P131 is genuinely multi-valued — Atlanta sits in both Fulton
      // and DeKalb County — so first-binding-wins would pick a different one
      // depending on how the endpoint ordered the rows. Lowest QID is arbitrary
      // but stable, and both candidates lead to the same state one hop up.
      // The nearest-parent rule lives in tools/resolve-place-chains.js, which
      // has the whole chain in hand and can tell which candidate contains which.
      const admin = new Map();
      for (const b of json.results.bindings) {
        const cand = b.adminParent?.value?.split('/').pop();
        if (cand) {
          const cur = admin.get(b.mb.value);
          const rank = (q) => Number(q.slice(1)) || Number.MAX_SAFE_INTEGER;
          if (!cur || rank(cand) < rank(cur)) admin.set(b.mb.value, cand);
        }
        if (found.has(b.mb.value)) continue; // first binding wins
        const m = /^Point\(([-\d.]+) ([-\d.]+)\)$/.exec(b.coord?.value ?? '');
        found.set(b.mb.value, {
          qid: b.place.value.split('/').pop(),
          lat: m ? Number(m[2]) : null,
          lon: m ? Number(m[1]) : null,
          isCity: b.isCity?.value === 'true' ? 1 : 0,
          parent: b.parent?.value?.split('/').pop() ?? null,
          country: b.countryLabel?.value ?? null,
          iso: b.iso?.value ?? null,
        });
      }
      for (const [mb, h] of found) h.adminParent = admin.get(mb) ?? null;
      db.exec('BEGIN');
      for (const id of batch) {
        const h = found.get(id);
        update.run(
          h?.qid ?? null, h?.lat ?? null, h?.lon ?? null,
          h?.isCity ?? null, h?.parent ?? null, h?.adminParent ?? null,
          h?.country ?? null, h?.iso ?? null,
          stamp, stamp, id
        );
        if (h?.lat != null) filled++;
      }
      db.exec('COMMIT');
      console.log(`    batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(todo.length / BATCH)} — ${filled} with coordinates`);
    } catch (err) {
      console.log(`    ! batch failed, will retry next run: ${err.message}`);
    }
  }
  console.log(`  ${filled} areas have coordinates`);
}

async function push() {
  console.log('\nPush to Turso');
  const url = process.env.MAPPIFY_INDEX_URL;
  const token = process.env.MAPPIFY_INDEX_TOKEN;
  if (!url || !token) {
    throw new Error(
      'MAPPIFY_INDEX_URL and MAPPIFY_INDEX_TOKEN must be set.\n' +
        '  Create a free database at turso.tech, then:\n' +
        '    turso db create mappify-index\n' +
        '    turso db show mappify-index --url\n' +
        '    turso db tokens create mappify-index'
    );
  }
  const { createClient } = await import('@libsql/client');
  const client = createClient({ url, authToken: token });

  await client.batch(
    [
      `CREATE TABLE IF NOT EXISTS artist_origin (
         spotify_id TEXT PRIMARY KEY, mbid TEXT NOT NULL, name TEXT, type TEXT,
         begin_area_id TEXT, area_id TEXT, country_iso TEXT)`,
      `CREATE TABLE IF NOT EXISTS area (
         mb_area_id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT, iso TEXT,
         wd_qid TEXT, lat REAL, lon REAL, is_city INTEGER, parent_qid TEXT,
         admin_parent_qid TEXT, country TEXT, country_iso TEXT)`,
      `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
    ],
    'write'
  );

  // A table created by an earlier push keeps its old columns — CREATE TABLE IF
  // NOT EXISTS is a no-op against it. Bring the remote up to the current shape
  // the same way the local databases do, rather than dropping and re-uploading
  // half a million rows every time a column is added.
  const remoteCols = new Set(
    (await client.execute("SELECT name FROM pragma_table_info('area')")).rows.map((r) => r.name)
  );
  for (const [column, type] of [
    ['wd_qid', 'TEXT'],
    ['is_city', 'INTEGER'],
    ['parent_qid', 'TEXT'],
    ['country', 'TEXT'],
    ['country_iso', 'TEXT'],
    ['admin_parent_qid', 'TEXT'],
  ]) {
    if (!remoteCols.has(column)) {
      await client.execute(`ALTER TABLE area ADD COLUMN ${column} ${type}`);
      console.log(`  added remote column area.${column}`);
    }
  }

  const CHUNK = 500;
  // Only areas some artist points at are ever looked up, and the free tier meters
  // writes — pushing all 120k when 17k are reachable would waste 100k of them.
  const AREA_FILTER = `WHERE mb_area_id IN (
      SELECT begin_area_id FROM artist_origin WHERE begin_area_id IS NOT NULL
      UNION SELECT area_id FROM artist_origin WHERE area_id IS NOT NULL)`;

  for (const [table, key, cols, filter] of [
    ['area', 'mb_area_id', ['mb_area_id', 'name', 'type', 'iso', 'wd_qid', 'lat', 'lon', 'is_city', 'parent_qid', 'admin_parent_qid', 'country', 'country_iso'], AREA_FILTER],
    ['artist_origin', 'spotify_id', ['spotify_id', 'mbid', 'name', 'type', 'begin_area_id', 'area_id', 'country_iso'], ''],
  ]) {
    const rows = db.prepare(`SELECT ${cols.join(',')} FROM ${table} ${filter}`).all();
    console.log(`  ${table}: ${rows.length} rows`);
    const placeholders = `(${cols.map(() => '?').join(',')})`;
    // DO NOTHING would mean a row already up there never learns a column added
    // later — the remote would keep answering with a null admin_parent_qid
    // forever while the local index had it. Every column here is derived from
    // the dump, so overwriting is always the correct resolution.
    const onConflict = `ON CONFLICT(${key}) DO UPDATE SET ${cols
      .filter((c) => c !== key)
      .map((c) => `${c}=excluded.${c}`)
      .join(', ')}`;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      await client.batch(
        slice.map((r) => ({
          sql: `INSERT INTO ${table} (${cols.join(',')}) VALUES ${placeholders}
                ${onConflict}`,
          args: cols.map((c) => r[c] ?? null),
        })),
        'write'
      );
      if ((i / CHUNK) % 40 === 0) console.log(`    ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
    }
  }
  const meta = db.prepare('SELECT key,value FROM meta').all();
  await client.batch(
    meta.map((m) => ({
      sql: 'INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      args: [m.key, m.value],
    })),
    'write'
  );
  console.log('  done');
}

const version = await latestVersion();
console.log(`MusicBrainz JSON dump ${version}`);
setMeta.run('dump_version', version);
setMeta.run('built_at', new Date().toISOString());

if (want('--areas')) await buildAreas(version);
if (want('--artists')) await buildArtists(version);
if (want('--coords')) await buildCoords();
if (want('--push')) await push();

if (!args.length) {
  console.log('\nNothing selected. Use --areas / --artists / --coords / --push / --all');
} else {
  const stats = db
    .prepare(
      `SELECT (SELECT count(*) FROM artist_origin) artists,
              (SELECT count(*) FROM area) areas,
              (SELECT count(*) FROM area WHERE lat IS NOT NULL) with_coords`
    )
    .get();
  console.log(`\nIndex at ${INDEX_DB}`);
  console.log(`  artists ${stats.artists} | areas ${stats.areas} | with coordinates ${stats.with_coords}`);
}
db.close();
