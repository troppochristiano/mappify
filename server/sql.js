// The SQL fragments more than one module has to agree on.
//
// These lived in api.js, which was fine while the API was the only thing that
// asked where an artist is from. The search index has to ask the same question
// — and answer it the same way, or a pinned artist is findable by the
// birthplace you corrected them away from — so the definitions moved here
// rather than being restated. There is still exactly one of each.

/** Display values: MusicBrainz first, Wikidata as fallback. */
export const CITY = 'COALESCE(a.mb_city, a.wd_city)';
export const COUNTRY = 'COALESCE(a.mb_country, a.wd_country)';

/**
 * The one definition of where an artist is, as a scalar subquery on `a`.
 *
 * Four routes in, most-trusted first. Your own correction wins outright; then
 * the origin from an artist's Wikipedia infobox, which says where an act is
 * *from* rather than where a person happened to be born; then a MusicBrainz
 * area (the normal path); then a directly-resolved Wikidata place, for the tail
 * MusicBrainz has no area for. Everything reads through this — when only the
 * area route existed, that tail had a city on screen but nothing on the map
 * could join to it, so those artists silently collected in Unknown.
 *
 * merged_into is applied here too: a shell resolves to the city it wraps.
 */
export const ARTIST_PLACE = `COALESCE(
  (SELECT COALESCE(p0.merged_into, p0.qid) FROM places p0 WHERE p0.qid = a.origin_override_qid),
  (SELECT COALESCE(pw.merged_into, pw.qid) FROM places pw WHERE pw.qid = a.origin_wiki_qid),
  (SELECT COALESCE(p.merged_into, p.qid) FROM place_areas pa
     JOIN places p ON p.qid = pa.qid
    WHERE pa.mb_area_id = a.mb_begin_area_id),
  (SELECT COALESCE(p2.merged_into, p2.qid) FROM places p2 WHERE p2.qid = a.place_qid)
)`;

/** The name of that place, for anything that shows or indexes it as text. */
export const ARTIST_PLACE_NAME = `(SELECT p9.name FROM places p9 WHERE p9.qid = ${ARTIST_PLACE})`;

/** Walks down the surviving place hierarchy — New York City brings its boroughs. */
export const PLACE_SUBTREE = `${ARTIST_PLACE} IN (
  WITH RECURSIVE sub(qid) AS (
    SELECT ?
    UNION
    SELECT c.qid FROM places c JOIN sub
      ON COALESCE((SELECT m.merged_into FROM places m WHERE m.qid = c.parent_qid), c.parent_qid) = sub.qid
     WHERE c.merged_into IS NULL AND c.qid <> sub.qid
  ) SELECT qid FROM sub
)`;

/**
 * A picture for an artist, out of what the library already holds.
 *
 * `artists.image_url` exists but is empty for every row: artist portraits were
 * never fetched, and since February 2026 there is no batch `GET /artists`, so
 * filling it would mean one request per artist. Album covers, on the other hand,
 * arrived with the tracks themselves and cover every artist in the library.
 *
 * So the artist's own portrait wins if it is ever populated, and otherwise this
 * falls back to the cover of their most-recent track — no extra Spotify calls at
 * any point. Ordered by rowid rather than by name so the same artist keeps the
 * same picture between requests instead of flickering between covers.
 *
 * The size token in a Spotify CDN path is swapped for the 64px variant, which is
 * what a 32px row actually needs even on a 2× display. Every stored cover but
 * one carries the 640px token, and a list can hold 200 rows: left alone that is
 * roughly 8MB of images to draw thumbnails with, against about 400KB. The
 * replace is a no-op on any URL that does not carry the token.
 */
export const ARTIST_IMAGE = `replace(COALESCE(a.image_url, (
  SELECT t.image_url FROM track_artists ta
    JOIN tracks t ON t.spotify_id = ta.track_id
   WHERE ta.artist_id = a.spotify_id AND t.image_url IS NOT NULL
   ORDER BY t.rowid DESC LIMIT 1)), 'ab67616d0000b273', 'ab67616d00004851')`;
