// Reads the shared origin index: Spotify artist ID -> MusicBrainz area, with
// coordinates. Built by tools/build-mb-index.js from the MusicBrainz dumps.
//
// This is what makes matching instant. The live API path costs two rate-limited
// requests per artist (~2.2s); here 600 artists is a few batched SELECTs.
//
// Config:
//   MAPPIFY_INDEX_URL / MAPPIFY_INDEX_TOKEN   hosted (Turso)
//   MAPPIFY_INDEX_FILE                          local .mbdump/mb-index.db
//
// With none of them set the caller falls back to the live MusicBrainz path, so
// a self-hoster who wants no external dependency still works — just slowly.

import './env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const BATCH = 400;

/**
 * Where to look for an index, in order.
 *
 * `index.db` beside the app is the one that ships inside the download — 63 MB
 * that turns a first import from twenty minutes of MusicBrainz at one request
 * per second into a few seconds of local reads, with no account, no token and no
 * network. It is why Spotify is the only remote thing this app needs.
 *
 * `.mbdump/mb-index.db` is the maintainer's working copy, kept last so a
 * development machine that has both uses the same file everyone else will.
 */
const LOCAL_CANDIDATES = [
  path.join(ROOT, 'index.db'),
  path.join(ROOT, 'data', 'index.db'),
  path.join(ROOT, '.mbdump', 'mb-index.db'),
];

let backend; // resolved once, then reused

async function resolveBackend() {
  if (backend !== undefined) return backend;

  // A hosted instance points at Turso explicitly. Everyone else reads the file
  // in their own download — no credential to publish, revoke, or have a quota
  // burned on, and nothing to reach over the network.
  const url = process.env.MAPPIFY_INDEX_URL;
  const token = process.env.MAPPIFY_INDEX_TOKEN;
  if (url && token) {
    const { createClient } = await import('@libsql/client');
    const client = createClient({ url, authToken: token });
    backend = {
      kind: 'remote',
      describe: url.replace(/^libsql:\/\//, ''),
      query: async (sql, args) => (await client.execute({ sql, args })).rows,
    };
    return backend;
  }

  const file = process.env.MAPPIFY_INDEX_FILE ?? LOCAL_CANDIDATES.find((f) => fs.existsSync(f));
  if (file && fs.existsSync(file)) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    backend = {
      kind: 'local',
      describe: file,
      query: async (sql, args) => db.prepare(sql).all(...args),
    };
    return backend;
  }

  backend = null;
  return backend;
}

export async function indexAvailable() {
  return (await resolveBackend()) !== null;
}

/**
 * Which columns an index actually has.
 *
 * A hosted index only learns a new column when someone runs the build tool's
 * --push, so between adding one here and pushing it, naming it in a SELECT
 * takes down every lookup with "no such column". Self-hosters pointed at an
 * older index would hit the same wall permanently. Asking first costs one
 * query per process.
 */
const columnCache = new Map();
async function columnsOf(b, table) {
  if (!columnCache.has(table)) {
    const rows = await b.query(`SELECT name FROM pragma_table_info('${table}')`, []);
    columnCache.set(table, new Set(rows.map((r) => r.name)));
  }
  return columnCache.get(table);
}
const areaColumns = (b) => columnsOf(b, 'area');

/**
 * Same idea one level up: the derived tables only exist on an index that has had
 * tools/push-derived.js run against it, and querying a missing table is an error
 * rather than an empty result.
 */
let tableNames;
async function hasTable(b, name) {
  if (!tableNames) {
    const rows = await b.query("SELECT name FROM sqlite_master WHERE type = 'table'", []);
    tableNames = new Set(rows.map((r) => r.name));
  }
  return tableNames.has(name);
}

/**
 * The settlement tree and the containment skeleton, as pushed by
 * tools/push-derived.js. Returns empty maps against an index without them, so an
 * older or self-built index still works — it just resolves places the slow way.
 *
 * @returns {Promise<{places: Map<string, object>, adminAreas: Map<string, object>}>}
 */
export async function lookupDerivedPlaces(qids) {
  const out = { places: new Map(), adminAreas: new Map() };
  const b = await resolveBackend();
  if (!b || !qids.length) return out;

  for (const [table, target] of [
    ['place', out.places],
    ['admin_area', out.adminAreas],
  ]) {
    if (!(await hasTable(b, table))) continue;
    const cols =
      table === 'place'
        ? 'qid, name, country, country_iso, lat, lon, parent_qid, is_city, capital_qid, admin_parent_qid'
        : 'qid, name, admin_parent_qid, capital_qid';
    for (let i = 0; i < qids.length; i += BATCH) {
      const slice = qids.slice(i, i + BATCH);
      const rows = await b.query(
        `SELECT ${cols} FROM ${table} WHERE qid IN (${slice.map(() => '?').join(',')})`,
        slice
      );
      for (const r of rows) target.set(r.qid, r);
    }
  }
  return out;
}

/**
 * Scene origins by MusicBrainz id — keyed that way rather than by Spotify id so
 * they apply to any library that has the artist at all.
 *
 * @returns {Promise<Map<string, string>>} mbid -> place qid
 */
export async function lookupWikiOrigins(mbids) {
  return lookupByMbid('artist_origin_wiki', mbids);
}

/**
 * Places for the artists MusicBrainz has no area for — resolved once through
 * Wikidata's P19/P740 and shared, rather than re-derived per install.
 *
 * @returns {Promise<Map<string, string>>} mbid -> place qid
 */
export async function lookupArtistPlaces(mbids) {
  return lookupByMbid('artist_place', mbids);
}

async function lookupByMbid(table, mbids) {
  const out = new Map();
  const b = await resolveBackend();
  if (!b || !mbids.length || !(await hasTable(b, table))) return out;

  for (let i = 0; i < mbids.length; i += BATCH) {
    const slice = mbids.slice(i, i + BATCH);
    const rows = await b.query(
      `SELECT mbid, place_qid FROM ${table} WHERE mbid IN (${slice.map(() => '?').join(',')})`,
      slice
    );
    for (const r of rows) out.set(r.mbid, r.place_qid);
  }
  return out;
}

export async function indexInfo() {
  const b = await resolveBackend();
  if (!b) return null;
  const rows = await b.query('SELECT key, value FROM meta', []);
  const meta = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { kind: b.kind, source: b.describe, ...meta };
}

/**
 * @param {string[]} spotifyIds
 * @returns {Promise<Map<string, {mbid, name, type, beginAreaId, areaId, countryIso,
 *   city, cityLat, cityLon, country, countryAreaIso}>>}
 */
export async function lookupArtists(spotifyIds) {
  const out = new Map();
  const b = await resolveBackend();
  if (!b || !spotifyIds.length) return out;

  // The bundled index drops artist names — the app shows Spotify's own name for
  // an artist, and 435,000 copies of a string nothing reads cost 8 MB in a file
  // people download. The maintainer's working index still has them.
  const cols = await columnsOf(b, 'artist_origin');
  const name = cols.has('name') ? 'ao.name' : 'NULL name';

  for (let i = 0; i < spotifyIds.length; i += BATCH) {
    const slice = spotifyIds.slice(i, i + BATCH);
    const holes = slice.map(() => '?').join(',');
    // One join gets the artist plus both of its areas resolved to names and
    // coordinates, so the caller never makes a second round trip.
    const rows = await b.query(
      `SELECT ao.spotify_id, ao.mbid, ${name}, ao.type, ao.country_iso,
              ao.begin_area_id, ao.area_id,
              ba.name begin_name, ba.lat begin_lat, ba.lon begin_lon,
              aa.name area_name, aa.iso area_iso
       FROM artist_origin ao
       LEFT JOIN area ba ON ba.mb_area_id = ao.begin_area_id
       LEFT JOIN area aa ON aa.mb_area_id = ao.area_id
       WHERE ao.spotify_id IN (${holes})`,
      slice
    );
    for (const r of rows) {
      out.set(r.spotify_id, {
        mbid: r.mbid,
        name: r.name,
        type: r.type,
        beginAreaId: r.begin_area_id,
        areaId: r.area_id,
        countryIso: r.country_iso,
        city: r.begin_name ?? null,
        cityLat: r.begin_lat ?? null,
        cityLon: r.begin_lon ?? null,
        country: r.area_name ?? null,
        countryAreaIso: r.area_iso ?? null,
      });
    }
  }
  return out;
}

/**
 * Areas by MusicBrainz area ID, or by Wikidata QID with `{byQid: true}` — the
 * second form is how a settlement parent is fetched, since a parent is reached
 * through P131 rather than by being someone's area.
 *
 * @returns {Promise<Map<string, {qid, name, lat, lon, isCity, parentQid, country, countryIso}>>}
 */
export async function lookupAreas(ids, { byQid = false } = {}) {
  const out = new Map();
  const b = await resolveBackend();
  if (!b || !ids.length) return out;

  const keyCol = byQid ? 'wd_qid' : 'mb_area_id';
  const cols = await areaColumns(b);
  const admin = cols.has('admin_parent_qid') ? 'admin_parent_qid' : 'NULL admin_parent_qid';
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const holes = slice.map(() => '?').join(',');
    const rows = await b.query(
      `SELECT mb_area_id, wd_qid, name, lat, lon, is_city, parent_qid, ${admin},
              country, country_iso
       FROM area WHERE ${keyCol} IN (${holes})`,
      slice
    );
    for (const r of rows) {
      out.set(byQid ? r.wd_qid : r.mb_area_id, {
        qid: r.wd_qid ?? null,
        name: r.name,
        lat: r.lat ?? null,
        lon: r.lon ?? null,
        isCity: r.is_city ?? null,
        parentQid: r.parent_qid ?? null,
        adminParentQid: r.admin_parent_qid ?? null,
        country: r.country ?? null,
        countryIso: r.country_iso ?? null,
      });
    }
  }
  return out;
}

if (import.meta.filename === process.argv[1]) {
  const info = await indexInfo();
  if (!info) {
    console.log('No index configured. Set MAPPIFY_INDEX_URL + MAPPIFY_INDEX_TOKEN,');
    console.log('or build one locally: node tools/build-mb-index.js --all');
    process.exit(1);
  }
  console.log(`index: ${info.kind} — ${info.source}`);
  console.log(`  dump ${info.dump_version ?? '?'} built ${info.built_at ?? '?'}`);
  console.log(`  ${info.artist_rows ?? '?'} artists, ${info.area_rows ?? '?'} areas`);

  const probe = process.argv[2] ? [process.argv[2]] : ['0epOFNiUfyON9EYx7Tpr6V'];
  const found = await lookupArtists(probe);
  for (const [id, a] of found) console.log(`  ${id} -> ${a.name} | ${a.city ?? '-'} | ${a.country ?? '-'} | ${a.mbid}`);
  if (!found.size) console.log('  (no match)');
}
