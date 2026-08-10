// Resolves MusicBrainz area IDs to real places: coordinates, country, and the
// settlement hierarchy that lets Brooklyn sit under New York City.
//
// Never matches by name — "Los Angeles" by label lands in Texas. The join is
// P982 (MusicBrainz area ID), the same discipline as resolving artists by
// Spotify URL rather than by name.
//
//   node server/places.js

import { openDb } from './db.js';
import { sparql } from './wikidata.js';

const BATCH = 120;
const MAX_ANCESTOR_LEVELS = 4;

const db = openDb();

const upsertPlace = db.prepare(`
  INSERT INTO places (qid, name, country, country_iso, lat, lon, parent_qid, is_city, capital_qid, resolved_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(qid) DO UPDATE SET
    name        = excluded.name,
    country     = COALESCE(excluded.country, places.country),
    country_iso = COALESCE(excluded.country_iso, places.country_iso),
    lat         = COALESCE(excluded.lat, places.lat),
    lon         = COALESCE(excluded.lon, places.lon),
    parent_qid  = COALESCE(excluded.parent_qid, places.parent_qid),
    is_city     = COALESCE(excluded.is_city, places.is_city),
    capital_qid = COALESCE(excluded.capital_qid, places.capital_qid),
    resolved_at = excluded.resolved_at
`);

const parseCoord = (wkt) => {
  const m = /^Point\(([-\d.]+) ([-\d.]+)\)$/.exec(wkt ?? '');
  return m ? { lon: Number(m[1]), lat: Number(m[2]) } : { lon: null, lat: null };
};

// A parent is only kept when it is itself a human settlement (Q486972). That is
// what separates "Brooklyn -> New York City" from "Atlanta -> Fulton County".
const SETTLEMENT_PARENT = `
  OPTIONAL {
    ?place wdt:P131 ?parent .
    FILTER EXISTS { ?parent wdt:P31/wdt:P279* wd:Q486972 }
  }`;

const FIELDS = `
  OPTIONAL { ?place wdt:P625 ?coord }
  OPTIONAL { ?place wdt:P17 ?country . OPTIONAL { ?country wdt:P297 ?iso } }
  ${SETTLEMENT_PARENT}
  BIND(EXISTS { ?place wdt:P31/wdt:P279* wd:Q515 } AS ?isCity)
  OPTIONAL { ?place wdt:P36 ?capital }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }`;

const mapArea = db.prepare(
  'INSERT INTO place_areas (mb_area_id, qid) VALUES (?,?) ON CONFLICT(mb_area_id) DO NOTHING'
);

function absorb(rows, keyField) {
  const stamp = new Date().toISOString();
  const seen = new Set();
  const parents = new Set();
  for (const b of rows) {
    const qid = b.place.value.split('/').pop();
    // The area -> place mapping is recorded for every binding, even when the
    // place row itself was already written by an earlier area.
    if (keyField === 'mb') mapArea.run(b.mb.value, qid);
    if (seen.has(qid)) continue; // first binding wins for the place attributes
    seen.add(qid);
    const { lat, lon } = parseCoord(b.coord?.value);
    const parentQid = b.parent?.value?.split('/').pop() ?? null;
    upsertPlace.run(
      qid,
      b.placeLabel?.value ?? qid,
      b.countryLabel?.value ?? null,
      b.iso?.value ?? null,
      lat,
      lon,
      parentQid,
      b.isCity?.value === 'true' ? 1 : 0,
      b.capital?.value?.split('/').pop() ?? null,
      stamp
    );
    if (parentQid) parents.add(parentQid);
  }
  return parents;
}

// Pass 1 — the areas artists actually point at, keyed by MusicBrainz area ID.
// Unresolved areas, plus any already-mapped area whose place is missing the
// is_city flag — otherwise a schema addition silently never backfills, and the
// collapse pass downstream reads the absence as "not a city".
const areaIds = db
  .prepare(
    `SELECT DISTINCT id FROM (
       SELECT mb_begin_area_id id FROM artists WHERE mb_begin_area_id IS NOT NULL
       UNION SELECT mb_area_id FROM artists WHERE mb_area_id IS NOT NULL
     )
     WHERE id NOT IN (SELECT mb_area_id FROM place_areas)
        OR id IN (SELECT pa.mb_area_id FROM place_areas pa
                  JOIN places p ON p.qid = pa.qid WHERE p.is_city IS NULL)`
  )
  .all()
  .map((r) => r.id);

console.log(`Resolving ${areaIds.length} MusicBrainz area(s) via Wikidata P982.`);

let pendingParents = new Set();
for (let i = 0; i < areaIds.length; i += BATCH) {
  const batch = areaIds.slice(i, i + BATCH);
  const V = batch.map((id) => `"${id}"`).join(' ');
  const q = `SELECT ?mb ?place ?placeLabel ?coord ?countryLabel ?iso ?parent ?isCity ?capital WHERE {
    VALUES ?mb { ${V} }
    ?place wdt:P982 ?mb .
    ${FIELDS}
  }`;
  try {
    const json = await sparql(q);
    const parents = absorb(json.results.bindings, 'mb');
    parents.forEach((p) => pendingParents.add(p));
    console.log(`  batch ${Math.floor(i / BATCH) + 1}: ${json.results.bindings.length} bindings`);
  } catch (err) {
    console.log(`  ! batch failed: ${err.message}`);
  }
}

// Pass 2 — ancestors, which usually are not MusicBrainz areas themselves.
// New York City appears only because Brooklyn points at it.
for (let level = 0; level < MAX_ANCESTOR_LEVELS && pendingParents.size; level++) {
  const known = new Set(db.prepare('SELECT qid FROM places').all().map((r) => r.qid));
  const todo = [...pendingParents].filter((q) => !known.has(q));
  pendingParents = new Set();
  if (!todo.length) break;

  console.log(`  ancestors level ${level + 1}: ${todo.length}`);
  for (let i = 0; i < todo.length; i += BATCH) {
    const V = todo.slice(i, i + BATCH).map((q) => `wd:${q}`).join(' ');
    const q = `SELECT ?place ?placeLabel ?coord ?countryLabel ?iso ?parent ?isCity ?capital WHERE {
      VALUES ?place { ${V} }
      ${FIELDS}
    }`;
    try {
      const json = await sparql(q);
      absorb(json.results.bindings, 'qid').forEach((p) => pendingParents.add(p));
    } catch (err) {
      console.log(`  ! ancestor batch failed: ${err.message}`);
    }
  }
}

// Backfill any place still missing a verdict. Ancestors arrive through P131
// rather than through an area ID, so the two passes above skip them once they
// exist — a new column would otherwise stay null on exactly the wrapper rows
// the collapse below needs to judge.
const needVerdict = db
  .prepare('SELECT qid FROM places WHERE is_city IS NULL')
  .all()
  .map((r) => r.qid);

if (needVerdict.length) {
  console.log(`\nBackfilling is_city for ${needVerdict.length} place(s).`);
  for (let i = 0; i < needVerdict.length; i += BATCH) {
    const V = needVerdict.slice(i, i + BATCH).map((q) => `wd:${q}`).join(' ');
    const q = `SELECT ?place ?placeLabel ?coord ?countryLabel ?iso ?parent ?isCity ?capital WHERE {
      VALUES ?place { ${V} }
      ${FIELDS}
    }`;
    try {
      absorb((await sparql(q)).results.bindings, 'qid');
    } catch (err) {
      console.log(`  ! backfill batch failed: ${err.message}`);
    }
  }
}

// Collapse administrative shells into the single city they wrap.
//
// Both conditions are required. "not a city" alone is not safe — Wikidata types
// Brooklyn as a borough rather than a city, so it fails that test too. What
// separates a shell from real containment is that it wraps exactly one
// settlement: Metropolitan City of Milan holds only Milan, while Greater London
// holds eight boroughs and Philadelphia holds a neighbourhood of its own.
db.exec('UPDATE places SET merged_into = NULL');

// A place with no is_city verdict is unknown, not "not a city". Collapsing on
// unknown data merged Liverpool into Walton and Babylon into Amityville the
// first time this ran, so it is now an explicit refusal rather than a default.
const unknown = db.prepare('SELECT count(*) n FROM places WHERE is_city IS NULL').get().n;
if (unknown) {
  console.log(
    `\nSkipping collapse: ${unknown} place(s) have no is_city verdict. ` +
      `Re-run once they resolve — merging on unknown data is how Liverpool ended up inside Walton.`
  );
}

const wrappers = unknown
  ? []
  : db
      .prepare(
        `SELECT p.qid, p.name,
                (SELECT c.qid FROM places c WHERE c.parent_qid = p.qid) child_qid,
                (SELECT c.name FROM places c WHERE c.parent_qid = p.qid) child_name
         FROM places p
         WHERE p.is_city = 0
           AND (SELECT count(*) FROM places c WHERE c.parent_qid = p.qid) = 1`
      )
      .all();

const setMerge = db.prepare('UPDATE places SET merged_into = ? WHERE qid = ?');
for (const w of wrappers) setMerge.run(w.child_qid, w.qid);

console.log(`\ncollapsed ${wrappers.length} administrative wrapper(s):`);
for (const w of wrappers) console.log(`  ${w.name} -> ${w.child_name}`);

const stats = db
  .prepare(
    `SELECT count(*) total,
            sum(CASE WHEN lat IS NOT NULL THEN 1 ELSE 0 END) coords,
            sum(CASE WHEN parent_qid IS NOT NULL THEN 1 ELSE 0 END) nested,
            sum(CASE WHEN merged_into IS NOT NULL THEN 1 ELSE 0 END) merged
     FROM places`
  )
  .get();
console.log(
  `\nplaces ${stats.total} | with coordinates ${stats.coords} | ` +
    `nested ${stats.nested} | merged away ${stats.merged}`
);

const sample = db
  .prepare(
    `SELECT c.name child, p.name parent FROM places c JOIN places p ON p.qid = c.parent_qid LIMIT 12`
  )
  .all();
for (const s of sample) console.log(`  ${s.child} -> ${s.parent}`);
db.close();
