// Copies places out of the shared index into the app's own tables, and folds
// administrative shells into the city they wrap.
//
// This exists because the two used to drift. The app's places/place_areas were
// built once by the standalone Wikidata pass in server/places.js, back when the
// library was 665 artists. Every artist imported after that pointed at a
// MusicBrainz area with no matching place row, so /api/tree filed them under
// their raw city name — and when the ISO was missing too, under "Unknown".
// Stockholm, Hamburg, Montréal and Sydney all ended up there despite the index
// knowing exactly where they are.
//
// Nothing here hits the network: the index already carries coordinates, the
// Wikidata QID, the settlement parent and the is_city verdict for every area.

import {
  lookupAreas,
  lookupDerivedPlaces,
  lookupWikiOrigins,
  lookupArtistPlaces,
} from './mbindex.js';
import { resolvePlacesByMbids } from './wikidata.js';

/**
 * @param {object} [opts]
 * @param {boolean} [opts.network] false to skip the Wikidata tail below.
 *   The index half of this is pure local reads and takes about a tenth of a
 *   second; the tail resolves artists MusicBrainz has no area for and costs
 *   SPARQL round trips. Callers that run this to get dots on screen quickly ask
 *   for the fast half only, and a later call picks up the rest.
 * @returns {Promise<{areas:number, places:number, missing:number}>}
 */
export async function syncPlacesFromIndex(db, { network = true } = {}) {
  const referenced = db
    .prepare(
      `SELECT DISTINCT id FROM (
         SELECT mb_begin_area_id id FROM artists WHERE mb_begin_area_id IS NOT NULL
         UNION SELECT mb_area_id FROM artists WHERE mb_area_id IS NOT NULL
       )`
    )
    .all()
    .map((r) => r.id);

  if (!referenced.length) return { areas: 0, places: 0, missing: 0 };

  const found = await lookupAreas(referenced);
  if (!found.size) return { areas: 0, places: 0, missing: referenced.length };

  // admin_parent_qid is the index's single P131 hop. tools/resolve-place-chains.js
  // resolves the same column with the whole chain in hand and can tell which of
  // two candidate parents contains the other, so a value already here is the
  // better-informed one and is kept.
  const upsertPlace = db.prepare(
    `INSERT INTO places (qid, name, country, country_iso, lat, lon, parent_qid, is_city,
                         admin_parent_qid, resolved_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(qid) DO UPDATE SET
       name        = excluded.name,
       country     = COALESCE(excluded.country, places.country),
       country_iso = COALESCE(excluded.country_iso, places.country_iso),
       lat         = COALESCE(excluded.lat, places.lat),
       lon         = COALESCE(excluded.lon, places.lon),
       parent_qid  = COALESCE(excluded.parent_qid, places.parent_qid),
       is_city     = COALESCE(excluded.is_city, places.is_city),
       admin_parent_qid = COALESCE(places.admin_parent_qid, excluded.admin_parent_qid),
       resolved_at = excluded.resolved_at`
  );
  const mapArea = db.prepare(
    'INSERT INTO place_areas (mb_area_id, qid) VALUES (?,?) ON CONFLICT(mb_area_id) DO UPDATE SET qid = excluded.qid'
  );

  const stamp = new Date().toISOString();
  let places = 0;
  let mapped = 0;

  db.exec('BEGIN');
  for (const [areaId, a] of found) {
    // Without a Wikidata QID there is nothing to key a place row on; the artist
    // keeps its raw city name and stays in the unresolved bucket, which is the
    // honest outcome rather than inventing an identifier.
    if (!a.qid) continue;
    upsertPlace.run(
      a.qid, a.name, a.country ?? null, a.countryIso ?? null,
      a.lat ?? null, a.lon ?? null, a.parentQid ?? null,
      a.isCity == null ? null : a.isCity, a.adminParentQid ?? null, stamp
    );
    mapArea.run(areaId, a.qid);
    places++;
    mapped++;
  }

  // Parents referenced by P131 are not themselves anyone's area, so they never
  // appear in the referenced list — but the tree needs them or a nested city has
  // nowhere to hang. Pull them in until the chain closes.
  let frontier = new Set(
    [...found.values()].map((a) => a.parentQid).filter(Boolean)
  );
  for (let depth = 0; depth < 4 && frontier.size; depth++) {
    const known = new Set(db.prepare('SELECT qid FROM places').all().map((r) => r.qid));
    const todo = [...frontier].filter((q) => !known.has(q));
    frontier = new Set();
    if (!todo.length) break;

    const parents = await lookupAreas(todo, { byQid: true });
    for (const a of parents.values()) {
      if (!a.qid) continue;
      upsertPlace.run(
        a.qid, a.name, a.country ?? null, a.countryIso ?? null,
        a.lat ?? null, a.lon ?? null, a.parentQid ?? null,
        a.isCity == null ? null : a.isCity, a.adminParentQid ?? null, stamp
      );
      places++;
      if (a.parentQid) frontier.add(a.parentQid);
    }
  }
  db.exec('COMMIT');

  const tail = network ? await resolveAreaLessArtists(db, upsertPlace, stamp) : 0;
  return { areas: mapped, places: places + tail, missing: referenced.length - found.size };
}

/**
 * The tail MusicBrainz has no area for at all.
 *
 * These were filled by the old Wikidata fallback, which stored a city *name* and
 * nothing else — so they had a city on screen but no place row anything could
 * join to, and landed in Unknown. Resolving the place's own QID gives them a real
 * row, recorded on artists.place_qid since there is no MusicBrainz area to key on.
 */
async function resolveAreaLessArtists(db, upsertPlace, stamp) {
  const pending = db
    .prepare(
      `SELECT DISTINCT a.mbid FROM artists a
       JOIN track_artists ta ON ta.artist_id = a.spotify_id AND ta.position = 0
       WHERE a.mbid IS NOT NULL
         AND a.mb_begin_area_id IS NULL
         AND a.place_qid IS NULL
         AND COALESCE(a.mb_city, a.wd_city) IS NOT NULL`
    )
    .all()
    .map((r) => r.mbid);

  if (!pending.length) return 0;

  let added = 0;
  const setArtistPlace = db.prepare('UPDATE artists SET place_qid = ? WHERE mbid = ?');
  for (let i = 0; i < pending.length; i += 120) {
    try {
      const found = await resolvePlacesByMbids(pending.slice(i, i + 120));
      db.exec('BEGIN');
      for (const [mbid, p] of found) {
        upsertPlace.run(
          p.placeQid, p.name ?? p.placeQid, p.country ?? null, p.iso ?? null,
          p.lat ?? null, p.lon ?? null, null, null, null, stamp
        );
        setArtistPlace.run(p.placeQid, mbid);
        added++;
      }
      db.exec('COMMIT');
    } catch (err) {
      console.log(`  ! area-less batch failed: ${err.message}`);
    }
  }
  return added;
}

/**
 * Pull the corrections someone already derived, out of the shared index.
 *
 * Without this a fresh install repeats work that has a known answer: the
 * containment chain costs a Wikidata round trip per place, and the scene origins
 * cost a Wikipedia article plus a category fetch per artist — minutes on a first
 * import, for facts that are identical for everybody.
 *
 * Three rules it will not break:
 *
 *   - A hand-pinned place always wins. origin_override_qid is never touched, and
 *     an artist who has one is skipped outright.
 *   - Local knowledge is never overwritten, only filled in. The chain resolver
 *     picks the *nearest* of several P131 parents; the index may carry a
 *     different one, and the local answer is the better-informed of the two.
 *   - Chain nodes go to admin_areas, never to places. Counties in `places` is
 *     what nested Bologna behind an administrative shell.
 *
 * @returns {Promise<{origins:number, places:number, chain:number}>}
 */
/**
 * The upsert every place-writing pass here shares.
 *
 * Existing values win over incoming ones throughout: a local run knows more than
 * the index does — the chain resolver picks the *nearest* of several P131
 * parents, where the index can only carry one hop.
 */
const placeUpsert = (db) =>
  db.prepare(
    `INSERT INTO places (qid, name, country, country_iso, lat, lon, parent_qid, is_city,
                         capital_qid, admin_parent_qid, resolved_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(qid) DO UPDATE SET
       country          = COALESCE(places.country, excluded.country),
       country_iso      = COALESCE(places.country_iso, excluded.country_iso),
       lat              = COALESCE(places.lat, excluded.lat),
       lon              = COALESCE(places.lon, excluded.lon),
       parent_qid       = COALESCE(places.parent_qid, excluded.parent_qid),
       is_city          = COALESCE(places.is_city, excluded.is_city),
       capital_qid      = COALESCE(places.capital_qid, excluded.capital_qid),
       admin_parent_qid = COALESCE(places.admin_parent_qid, excluded.admin_parent_qid)`
  );

/** Makes sure `places` holds a row for each qid, so a pointer at one is legal. */
async function ensurePlaceRows(db, qids) {
  const missing = qids.filter(
    (q) => q && !db.prepare('SELECT 1 ok FROM places WHERE qid = ?').get(q)
  );
  if (!missing.length) return 0;

  const { places: found } = await lookupDerivedPlaces(missing);
  if (!found.size) return 0;

  const upsert = placeUpsert(db);
  const stamp = new Date().toISOString();
  db.exec('BEGIN');
  for (const r of found.values()) {
    upsert.run(
      r.qid, r.name, r.country ?? null, r.country_iso ?? null, r.lat ?? null, r.lon ?? null,
      r.parent_qid ?? null, r.is_city ?? null, r.capital_qid ?? null,
      r.admin_parent_qid ?? null, stamp
    );
  }
  db.exec('COMMIT');
  return found.size;
}

export async function syncDerivedArtists(db) {
  // Artists still on a birthplace, that nobody has pinned by hand.
  const pending = db
    .prepare(
      `SELECT DISTINCT a.mbid FROM artists a
        WHERE a.mbid IS NOT NULL AND a.mbid <> ''
          AND a.origin_wiki_qid IS NULL AND a.origin_override_qid IS NULL
          AND EXISTS (SELECT 1 FROM track_artists ta WHERE ta.artist_id = a.spotify_id)`
    )
    .all()
    .map((r) => r.mbid);

  // The area-less tail, whose place cannot be reached through any area id.
  const areaLess = db
    .prepare(
      `SELECT DISTINCT a.mbid FROM artists a
        WHERE a.mbid IS NOT NULL AND a.mbid <> ''
          AND a.mb_begin_area_id IS NULL AND a.place_qid IS NULL`
    )
    .all()
    .map((r) => r.mbid);

  const [origins, artistPlaces] = await Promise.all([
    lookupWikiOrigins(pending),
    lookupArtistPlaces(areaLess),
  ]);

  const setOrigin = db.prepare(
    `UPDATE artists SET origin_wiki_qid = ?
      WHERE mbid = ? AND origin_wiki_qid IS NULL AND origin_override_qid IS NULL`
  );
  const setPlace = db.prepare(
    'UPDATE artists SET place_qid = ? WHERE mbid = ? AND place_qid IS NULL'
  );

  // The rows those pointers will reference, fetched first.
  //
  // `artists.place_qid` is a foreign key into places(qid), so pointing at a
  // place that has not arrived yet fails outright — the whole import ends on
  // "FOREIGN KEY constraint failed". It went unnoticed because every test that
  // wiped `places` beforehand also turned foreign keys off on the same
  // connection to do the wiping.
  //
  // `origin_wiki_qid` has no such constraint, and syncDerivedPlaces() below
  // still walks from both columns to pull the chain above them.
  await ensurePlaceRows(db, [...new Set(artistPlaces.values())]);

  db.exec('BEGIN');
  let originCount = 0;
  let placeCount = 0;
  for (const [mbid, qid] of origins) originCount += setOrigin.run(qid, mbid).changes;
  for (const [mbid, qid] of artistPlaces) placeCount += setPlace.run(qid, mbid).changes;
  db.exec('COMMIT');

  return { origins: originCount, artistPlaces: placeCount };
}

/**
 * The place rows and the chain above them, for everything the database now
 * points at. Runs after the artist columns are set and after areas are synced,
 * so one walk covers every place any route can reach.
 *
 * @returns {Promise<{places:number, chain:number}>}
 */
export async function syncDerivedPlaces(db) {
  const wanted = new Set(
    db.prepare(`SELECT qid FROM places WHERE qid LIKE 'Q%'`).all().map((r) => r.qid)
  );
  for (const r of db
    .prepare(
      `SELECT origin_wiki_qid q FROM artists WHERE origin_wiki_qid IS NOT NULL
       UNION SELECT place_qid FROM artists WHERE place_qid IS NOT NULL`
    )
    .all()) {
    if (r.q) wanted.add(r.q);
  }

  const upsertPlace = db.prepare(
    `INSERT INTO places (qid, name, country, country_iso, lat, lon, parent_qid, is_city,
                         capital_qid, admin_parent_qid, resolved_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(qid) DO UPDATE SET
       country          = COALESCE(places.country, excluded.country),
       country_iso      = COALESCE(places.country_iso, excluded.country_iso),
       lat              = COALESCE(places.lat, excluded.lat),
       lon              = COALESCE(places.lon, excluded.lon),
       parent_qid       = COALESCE(places.parent_qid, excluded.parent_qid),
       is_city          = COALESCE(places.is_city, excluded.is_city),
       capital_qid      = COALESCE(places.capital_qid, excluded.capital_qid),
       admin_parent_qid = COALESCE(places.admin_parent_qid, excluded.admin_parent_qid)`
  );
  const upsertNode = db.prepare(
    `INSERT INTO admin_areas (qid, name, admin_parent_qid, capital_qid, resolved_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(qid) DO UPDATE SET
       name             = COALESCE(admin_areas.name, excluded.name),
       admin_parent_qid = COALESCE(admin_areas.admin_parent_qid, excluded.admin_parent_qid),
       capital_qid      = COALESCE(admin_areas.capital_qid, excluded.capital_qid)`
  );
  const stamp = new Date().toISOString();
  let placeRows = 0;
  let chainRows = 0;
  const seen = new Set();
  let frontier = [...wanted];

  // Walk up the chain the index describes. Four rounds closes every real
  // hierarchy; the guard is against a cycle, not against depth.
  for (let depth = 0; depth < 8 && frontier.length; depth++) {
    const todo = frontier.filter((q) => q && !seen.has(q));
    todo.forEach((q) => seen.add(q));
    if (!todo.length) break;

    const { places: p, adminAreas: a } = await lookupDerivedPlaces(todo);
    if (!p.size && !a.size) break;

    const next = new Set();
    db.exec('BEGIN');
    for (const r of p.values()) {
      upsertPlace.run(
        r.qid, r.name, r.country ?? null, r.country_iso ?? null, r.lat ?? null, r.lon ?? null,
        r.parent_qid ?? null, r.is_city ?? null, r.capital_qid ?? null,
        r.admin_parent_qid ?? null, stamp
      );
      // The place's own chain row, so containment can walk from it.
      upsertNode.run(r.qid, r.name, r.admin_parent_qid ?? null, r.capital_qid ?? null, stamp);
      placeRows++;
      if (r.admin_parent_qid) next.add(r.admin_parent_qid);
      if (r.parent_qid) next.add(r.parent_qid);
    }
    for (const r of a.values()) {
      upsertNode.run(r.qid, r.name, r.admin_parent_qid ?? null, r.capital_qid ?? null, stamp);
      chainRows++;
      if (r.admin_parent_qid) next.add(r.admin_parent_qid);
    }
    db.exec('COMMIT');
    frontier = [...next];
  }

  // An artist pointed at a place the index could not supply would sit in Unknown
  // forever, so say so rather than leaving it to be noticed on the map.
  const dangling = db
    .prepare(
      `SELECT count(*) n FROM artists a
        WHERE a.origin_wiki_qid IS NOT NULL
          AND a.origin_wiki_qid NOT IN (SELECT qid FROM places)`
    )
    .get().n;

  return { places: placeRows, chain: chainRows, dangling };
}

/**
 * Folds an administrative shell into the single city it wraps: Metropolitan City
 * of Milan becomes Milan.
 *
 * Both conditions are required. "not a city" alone is unsafe — Wikidata types
 * Brooklyn as a borough, so it fails that test too. What separates a shell from
 * real containment is wrapping exactly one settlement: Greater London holds
 * eight boroughs and keeps them; Philadelphia holds a neighbourhood of its own.
 *
 * A place with no is_city verdict is *unknown*, not "not a city". Treating the
 * absence as false once merged Liverpool into Walton, so it is refused outright.
 */
export function collapseWrappers(db) {
  // Only a place with children can be a wrapper, so only those need a verdict.
  // Guarding on every place made one unresolvable leaf block the whole pass.
  const unknown = db
    .prepare(
      `SELECT count(*) n FROM places p
       WHERE p.is_city IS NULL
         AND EXISTS (SELECT 1 FROM places c WHERE c.parent_qid = p.qid)`
    )
    .get().n;
  // Checked *before* the reset below, not after. The other way round, a refused
  // pass had already cleared every existing merge on its way to refusing — so
  // running this against a half-built graph split Milan back into two dots until
  // something completed a full pass. A refusal must be a no-op.
  if (unknown) return { collapsed: 0, skipped: unknown };

  db.exec('UPDATE places SET merged_into = NULL');

  const wrappers = db
    .prepare(
      `SELECT p.qid, (SELECT c.qid FROM places c WHERE c.parent_qid = p.qid) child_qid
       FROM places p
       WHERE p.is_city = 0
         AND (SELECT count(*) FROM places c WHERE c.parent_qid = p.qid) = 1`
    )
    .all();

  const set = db.prepare('UPDATE places SET merged_into = ? WHERE qid = ?');
  db.exec('BEGIN');
  for (const w of wrappers) set.run(w.child_qid, w.qid);
  db.exec('COMMIT');
  return { collapsed: wrappers.length, skipped: 0 };
}
