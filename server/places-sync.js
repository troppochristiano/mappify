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

import { lookupAreas } from './mbindex.js';
import { resolvePlacesByMbids } from './wikidata.js';

/**
 * @returns {Promise<{areas:number, places:number, missing:number}>}
 */
export async function syncPlacesFromIndex(db) {
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

  const tail = await resolveAreaLessArtists(db, upsertPlace, stamp);
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
  db.exec('UPDATE places SET merged_into = NULL');

  // Only a place with children can be a wrapper, so only those need a verdict.
  // Guarding on every place made one unresolvable leaf block the whole pass.
  const unknown = db
    .prepare(
      `SELECT count(*) n FROM places p
       WHERE p.is_city IS NULL
         AND EXISTS (SELECT 1 FROM places c WHERE c.parent_qid = p.qid)`
    )
    .get().n;
  if (unknown) return { collapsed: 0, skipped: unknown };

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
