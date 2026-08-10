// Local REST API over mappify.db. Plain node:http — no framework.
// Read-only for now; sync and export endpoints arrive with Phases 2 and 6.

import './env.js';
import http from 'node:http';
import { openUserDb } from './db.js';
import { runAsUser, currentDb, currentUserId } from './context.js';
import {
  authStatus,
  beginAuth,
  completeAuth,
  disconnect,
  allowlistHint,
  publicUrl,
  REDIRECT_URI,
} from './auth.js';
import { userForRequest, endSession, sessionCookie, clearCookie } from './session.js';
import { runImport, status as importStatus, cancel as cancelImport } from './jobs.js';
import { createPlaylist } from './sources/spotify.js';
import { indexInfo } from './mbindex.js';

const PORT = Number(process.env.MAPPIFY_PORT ?? 8787);
const WEB_ORIGIN = process.env.MAPPIFY_WEB ?? 'http://127.0.0.1:5273';
// Loopback unless told otherwise. A hosted instance sets MAPPIFY_HOST=0.0.0.0,
// which is a decision to expose the thing and should have to be made on purpose.
const HOST = process.env.MAPPIFY_HOST ?? '127.0.0.1';

// Every query runs against whoever the request belongs to. There is no
// module-level database any more: the old `const db = openDb()` was the single
// object that made this server single-tenant, and reading from the async-scoped
// context is what stops a handler quietly serving the wrong library.
const all = (sql, ...params) => currentDb().prepare(sql).all(...params);
const one = (sql, ...params) => currentDb().prepare(sql).get(...params);

// Display values: MusicBrainz first, Wikidata as fallback. Both are kept in the
// DB; this only decides what the UI shows by default.
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
const ARTIST_IMAGE = `replace(COALESCE(a.image_url, (
  SELECT t.image_url FROM track_artists ta
    JOIN tracks t ON t.spotify_id = ta.track_id
   WHERE ta.artist_id = a.spotify_id AND t.image_url IS NOT NULL
   ORDER BY t.rowid DESC LIMIT 1)), 'ab67616d0000b273', 'ab67616d00004851')`;

/**
 * Narrow a `track_artists ta` join to one source in the library.
 *
 * Everything the map shows is counted through that join, so restricting it here
 * makes "only my Liked Songs" or "only this playlist" mean the same thing in
 * every view at once — the dots, the counts, the tree and the artist lists.
 *
 * The id is interpolated rather than bound because the call sites all use
 * positional parameters in different orders, and threading one more through
 * each is how the wrong value ends up in the wrong slot. It is coerced to a
 * positive integer first and anything else yields no clause at all, so there is
 * nothing here for a caller to inject.
 */
function sourceFilter(raw) {
  const id = Number(raw);
  if (!raw || !Number.isInteger(id) || id <= 0) return '';
  return ` AND EXISTS (SELECT 1 FROM track_sources ts
             WHERE ts.track_id = ta.track_id AND ts.source_id = ${id})`;
}

const CITY = 'COALESCE(a.mb_city, a.wd_city)';
const COUNTRY = 'COALESCE(a.mb_country, a.wd_country)';

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
const ARTIST_PLACE = `COALESCE(
  (SELECT COALESCE(p0.merged_into, p0.qid) FROM places p0 WHERE p0.qid = a.origin_override_qid),
  (SELECT COALESCE(pw.merged_into, pw.qid) FROM places pw WHERE pw.qid = a.origin_wiki_qid),
  (SELECT COALESCE(p.merged_into, p.qid) FROM place_areas pa
     JOIN places p ON p.qid = pa.qid
    WHERE pa.mb_area_id = a.mb_begin_area_id),
  (SELECT COALESCE(p2.merged_into, p2.qid) FROM places p2 WHERE p2.qid = a.place_qid)
)`;

/** Walks down the surviving place hierarchy — New York City brings its boroughs. */
const PLACE_SUBTREE = `${ARTIST_PLACE} IN (
  WITH RECURSIVE sub(qid) AS (
    SELECT ?
    UNION
    SELECT c.qid FROM places c JOIN sub
      ON COALESCE((SELECT m.merged_into FROM places m WHERE m.qid = c.parent_qid), c.parent_qid) = sub.qid
     WHERE c.merged_into IS NULL AND c.qid <> sub.qid
  ) SELECT qid FROM sub
)`;

/** Every liked/playlist track whose primary artist is from a place. */
function placeTracks({ qid, iso }) {
  const where = qid ? PLACE_SUBTREE : 'a.mb_country_iso = ?';
  return all(
    `SELECT DISTINCT t.spotify_id, t.name, t.uri, a.name artist, ${CITY} city
     FROM artists a
     JOIN track_artists ta ON ta.artist_id = a.spotify_id AND ta.position = 0
     JOIN tracks t ON t.spotify_id = ta.track_id
     WHERE ${where}
     ORDER BY a.name COLLATE NOCASE, t.name COLLATE NOCASE`,
    qid ?? iso
  );
}

const routes = {
  '/api/stats': () => {
    const t = one('SELECT count(*) n FROM tracks');
    const a = one('SELECT count(*) n FROM artists WHERE status IS NOT NULL');
    const cov = one(`
      SELECT count(*) total,
             sum(CASE WHEN ${CITY} IS NOT NULL THEN 1 ELSE 0 END) city,
             sum(CASE WHEN ${COUNTRY} IS NOT NULL THEN 1 ELSE 0 END) country
      FROM track_artists ta JOIN artists a ON a.spotify_id = ta.artist_id
      WHERE ta.position = 0`);
    return {
      tracks: t.n,
      artists: a.n,
      trackRows: cov.total,
      withCity: cov.city,
      withCountry: cov.country,
      sources: all('SELECT id, kind, name, track_total, last_synced_at FROM sources'),
    };
  },

  // Artist-first: the result set is artists, each carrying its own track count.
  '/api/artists': (url) => {
    const q = (url.searchParams.get('q') ?? '').trim();
    const city = url.searchParams.get('city');
    const country = url.searchParams.get('country');
    const placeQid = url.searchParams.get('placeQid');
    const iso = url.searchParams.get('iso');
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const SRC = sourceFilter(url.searchParams.get('source'));

    const where = [];
    const params = [];
    if (q) {
      // Prefix-match the last token so typing feels live.
      const match = q
        .split(/\s+/)
        .map((tok) => tok.replace(/["*]/g, ''))
        .filter(Boolean)
        .map((tok) => `"${tok}"*`)
        .join(' ');
      where.push('a.spotify_id IN (SELECT spotify_id FROM artist_search WHERE artist_search MATCH ?)');
      params.push(match);
    }
    if (city) {
      where.push(`${CITY} = ?`);
      params.push(city);
    }
    if (country) {
      where.push(`${COUNTRY} = ?`);
      params.push(country);
    }
    if (iso) {
      where.push('a.mb_country_iso = ?');
      params.push(iso);
    }
    // The Unknown bucket is a real selection, not an absence of one — you should
    // be able to open it and see who has no known origin.
    if (url.searchParams.get('unknown') === '1') {
      where.push(`${ARTIST_PLACE} IS NULL`);
    }
    // Artists placed in a country but no town. Combined with `iso` this is the
    // "Somewhere in the United States" bucket the tree exposes; on its own it
    // would be every cityless artist anywhere.
    if (url.searchParams.get('cityless') === '1') {
      where.push(`${ARTIST_PLACE} IS NULL AND COALESCE(${CITY}, '') = ''`);
    }
    // Selecting a place includes everything under it: New York City brings
    // Brooklyn, Manhattan and Harlem with it.
    if (placeQid) {
      // Walk down the surviving hierarchy, then map back to every area id that
      // resolves into it — including areas whose place was merged away.
      where.push(PLACE_SUBTREE);
      params.push(placeQid);
    }
    // An artist with no tracks left after the source filter drops out of the
    // list entirely, rather than sitting there claiming zero.
    where.push(`EXISTS (SELECT 1 FROM track_artists ta WHERE ta.artist_id = a.spotify_id${SRC})`);

    const sql = `
      SELECT a.spotify_id, a.name, a.artist_type, a.status, a.source, a.fuzzy,
             -- A pinned place replaces the name too, or the row would keep
             -- claiming the birthplace it was corrected away from.
             COALESCE((SELECT p3.name FROM places p3 WHERE p3.qid = a.origin_override_qid),
                      (SELECT p4.name FROM places p4 WHERE p4.qid = a.origin_wiki_qid),
                      ${CITY}) city,
             a.origin_override_qid IS NOT NULL origin_pinned,
             CASE WHEN a.origin_override_qid IS NOT NULL THEN 'you'
                  WHEN a.origin_wiki_qid IS NOT NULL THEN 'wikipedia' END origin_source,
             ${COUNTRY} country, a.mb_country_iso,
             a.mb_city, a.mb_country, a.wd_city, a.wd_country,
             ${ARTIST_PLACE} place_qid,
             (SELECT count(*) FROM track_artists ta WHERE ta.artist_id = a.spotify_id${SRC}) tracks,
             ${ARTIST_IMAGE} image_url
      FROM artists a
      WHERE ${where.join(' AND ')}
      ORDER BY tracks DESC, a.name COLLATE NOCASE
      LIMIT ? OFFSET ?`;
    const items = all(sql, ...params, limit, offset);
    const total = one(
      `SELECT count(*) n FROM artists a WHERE ${where.join(' AND ')}`,
      ...params
    ).n;
    return { total, items };
  },

  '/api/artist': (url) => {
    const id = url.searchParams.get('id');
    if (!id) return { error: 'id required' };
    const artist = one(
      `SELECT a.*,
              COALESCE((SELECT p3.name FROM places p3 WHERE p3.qid = a.origin_override_qid),
                       (SELECT p4.name FROM places p4 WHERE p4.qid = a.origin_wiki_qid),
                       ${CITY}) city,
              a.origin_override_qid IS NOT NULL origin_pinned,
              CASE WHEN a.origin_override_qid IS NOT NULL THEN 'you'
                   WHEN a.origin_wiki_qid IS NOT NULL THEN 'wikipedia' END origin_source,
              ${COUNTRY} country
         FROM artists a WHERE a.spotify_id = ?`,
      id
    );
    if (!artist) return { error: 'not found' };
    const tracks = all(
      `SELECT t.spotify_id, t.name, t.album, t.url, ta.position,
              (SELECT group_concat(s.name, ', ') FROM track_sources ts
               JOIN sources s ON s.id = ts.source_id WHERE ts.track_id = t.spotify_id) sources
       FROM track_artists ta JOIN tracks t ON t.spotify_id = ta.track_id
       WHERE ta.artist_id = ? ORDER BY t.name COLLATE NOCASE`,
      id
    );
    return { artist, tracks };
  },

  /**
   * Country -> city -> section tree.
   *
   * Countries come from the ISO code, labelled with Intl.DisplayNames — a
   * published standard rather than a hand-written table, and it keeps Puerto
   * Rico distinct from the United States instead of quietly folding it in.
   *
   * Cities nest by the Wikidata settlement hierarchy: Brooklyn under New York
   * City, Harlem under Manhattan under New York City. Atlanta stays top-level
   * because its only parents are counties.
   */
  '/api/tree': (url) => {
    const SRC = sourceFilter(url.searchParams.get('source'));
    const regionName = (iso) => {
      if (!iso) return null;
      try {
        return new Intl.DisplayNames(['en'], { type: 'region' }).of(iso) ?? iso;
      } catch {
        return iso;
      }
    };

    // Merged-away shells are excluded outright; their children take their place.
    const places = new Map();
    for (const p of all(
      'SELECT qid, name, country_iso, parent_qid, lat, lon FROM places WHERE merged_into IS NULL'
    )) {
      places.set(p.qid, { ...p, tracks: 0, artists: 0, children: [] });
    }

    // Artists that resolve to a real place, by either route.
    const resolved = all(`
      SELECT ${ARTIST_PLACE}               qid,
             count(DISTINCT ta.track_id)   tracks,
             count(DISTINCT a.spotify_id)  artists,
             max(a.mb_country_iso)         artist_iso
      FROM artists a
      JOIN track_artists ta ON ta.artist_id = a.spotify_id AND ta.position = 0${SRC}
      WHERE ${ARTIST_PLACE} IS NOT NULL
      GROUP BY ${ARTIST_PLACE}`);
    for (const r of resolved) {
      const node = places.get(r.qid);
      if (!node) continue;
      node.tracks += r.tracks;
      node.artists += r.artists;
      node.country_iso ??= r.artist_iso;
    }

    // Artists with no resolved area yet (not enriched, or MusicBrainz has no
    // area at all). They keep their raw city name as a leaf rather than vanishing.
    const unresolved = all(`
      SELECT COALESCE(${CITY}, '')          city,
             COALESCE(a.mb_country_iso, '') iso,
             count(DISTINCT ta.track_id)    tracks,
             count(DISTINCT a.spotify_id)   artists
      FROM artists a
      JOIN track_artists ta ON ta.artist_id = a.spotify_id AND ta.position = 0${SRC}
      WHERE ${ARTIST_PLACE} IS NULL
      GROUP BY city, iso`);

    // Assemble: every place hangs off its nearest surviving settlement ancestor.
    //
    // Collapsing a shell inverts one link: Milan's parent was Metropolitan City
    // of Milan, which merged into Milan, so the parent now resolves to Milan
    // itself. A self-parent means the node is a root, not a cycle.
    const mergeTargets = new Map(
      all('SELECT qid, merged_into FROM places WHERE merged_into IS NOT NULL').map((r) => [
        r.qid,
        r.merged_into,
      ])
    );
    const resolveParent = (qid) => {
      const target = mergeTargets.get(qid) ?? qid;
      return places.has(target) ? target : null;
    };

    for (const node of places.values()) {
      const parentQid = node.parent_qid ? resolveParent(node.parent_qid) : null;
      node.parent_qid = parentQid && parentQid !== node.qid ? parentQid : null;
    }
    for (const node of places.values()) {
      const parent = node.parent_qid ? places.get(node.parent_qid) : null;
      if (parent) parent.children.push(node);
    }

    const countries = new Map();
    const countryOf = (iso) => {
      const key = iso || 'ZZ';
      if (!countries.has(key)) {
        countries.set(key, {
          iso: iso || null,
          name: iso ? regionName(iso) : 'Unknown',
          tracks: 0,
          artists: 0,
          children: [],
        });
      }
      return countries.get(key);
    };

    // Roll counts up through the settlement chain first.
    const totals = (node) => {
      let tracks = node.tracks;
      let artists = node.artists;
      for (const child of node.children) {
        const t = totals(child);
        tracks += t.tracks;
        artists += t.artists;
      }
      node.totalTracks = tracks;
      node.totalArtists = artists;
      return { tracks, artists };
    };

    for (const node of places.values()) {
      if (node.parent_qid && places.has(node.parent_qid)) continue; // not a root
      const t = totals(node);
      if (!t.tracks) continue; // a place nobody in the library is from
      const country = countryOf(node.country_iso);
      country.children.push(node);
      country.tracks += t.tracks;
      country.artists += t.artists;
    }

    for (const u of unresolved) {
      if (!u.tracks) continue;
      const country = countryOf(u.iso);
      // An artist MusicBrainz places in a country but no town is not "unknown" —
      // we know the country, and 94 US artists land here. It used to show as
      // "Unknown city", which was both wrong and unopenable: the client filtered
      // on the label, so the row always opened onto an empty list. It now says
      // where it is and carries the filter that finds those artists.
      const cityless = !u.city;
      country.children.push({
        qid: null,
        // Named without the country: the row already sits inside it, and
        // Intl.DisplayNames has no articles, so anything of the form
        // "Somewhere in ___" reads as "Somewhere in United States".
        name: cityless ? (u.iso ? 'City unknown' : 'No known origin') : u.city,
        tracks: u.tracks,
        artists: u.artists,
        totalTracks: u.tracks,
        totalArtists: u.artists,
        children: [],
        unresolved: true,
        // What actually selects this row, as opposed to what it is called.
        city: u.city || null,
        iso: u.iso || null,
        cityless,
      });
      country.tracks += u.tracks;
      country.artists += u.artists;
    }

    const sortNodes = (nodes) => {
      nodes.sort((a, b) => b.totalTracks - a.totalTracks || a.name.localeCompare(b.name));
      for (const n of nodes) sortNodes(n.children);
    };

    const list = [...countries.values()];
    for (const c of list) sortNodes(c.children);
    list.sort((a, b) => {
      if (a.name === 'Unknown') return 1;
      if (b.name === 'Unknown') return -1;
      return b.tracks - a.tracks || a.name.localeCompare(b.name);
    });

    return { countries: list };
  },

  /**
   * A track to play for a place: any liked track by an artist from there.
   * Random, so re-tuning the same dot gives you something different.
   */
  '/api/place-track': (url) => {
    const qid = url.searchParams.get('qid');
    if (!qid) return { error: 'qid required' };
    const track = one(
      `SELECT t.spotify_id, t.name, t.uri, t.album, t.image_url, a.name artist, ${CITY} city
       FROM artists a
       JOIN track_artists ta ON ta.artist_id = a.spotify_id AND ta.position = 0
       JOIN tracks t ON t.spotify_id = ta.track_id
       WHERE ${PLACE_SUBTREE}
       ORDER BY random() LIMIT 1`,
      qid
    );
    return track ?? { error: 'no track for that place' };
  },

  /** A track by one artist, for the play button on an artist row. */
  '/api/artist-track': (url) => {
    const id = url.searchParams.get('id');
    if (!id) return { error: 'id required' };
    const track = one(
      `SELECT t.spotify_id, t.name, t.uri, t.album, t.image_url, a.name artist, ${CITY} city
       FROM artists a
       JOIN track_artists ta ON ta.artist_id = a.spotify_id
       JOIN tracks t ON t.spotify_id = ta.track_id
       WHERE a.spotify_id = ?
       ORDER BY random() LIMIT 1`,
      id
    );
    return track ?? { error: 'no track for that artist' };
  },

  /** Points for the map: one per resolved place that has coordinates. */
  '/api/map': (url) => {
    const SRC = sourceFilter(url.searchParams.get('source'));
    // Grouped by the surviving place, so Milan is one dot rather than two.
    const points = all(`
      SELECT s.qid, s.name, s.lat, s.lon, s.country_iso,
             count(DISTINCT ta.track_id)  tracks,
             count(DISTINCT a.spotify_id) artists
      FROM artists a
      JOIN places s ON s.qid = ${ARTIST_PLACE}
      JOIN track_artists ta ON ta.artist_id = a.spotify_id AND ta.position = 0${SRC}
      WHERE s.lat IS NOT NULL AND s.lon IS NOT NULL
      GROUP BY s.qid
      ORDER BY tracks DESC`);
    const missing = one(`
      SELECT count(DISTINCT ta.track_id) tracks
      FROM artists a
      JOIN track_artists ta ON ta.artist_id = a.spotify_id AND ta.position = 0${SRC}
      WHERE ${ARTIST_PLACE} IS NULL
         OR ${ARTIST_PLACE} NOT IN (SELECT qid FROM places WHERE lat IS NOT NULL)`);
    return { points, unmappedTracks: missing.tracks };
  },

  /**
   * The two ways places relate to each other, for drawing as strings.
   *
   * `nesting` is containment — Brooklyn to New York City, the same tree the
   * browse menu walks — so a cluster of dots reads as one city with its
   * boroughs rather than as unrelated places that happen to sit close together.
   * Merged-away shells are excluded on both ends, so a child hangs off the place
   * that actually survived rather than an administrative wrapper folded into it.
   *
   * `collab` is who worked with whom. Both ship in one response because both are
   * small and fixed for a given library, so toggling between them on the globe
   * costs nothing.
   */
  '/api/links': () => {
    const nesting = all(`
      SELECT c.qid a, p.qid b, c.lat alat, c.lon alon, p.lat blat, p.lon blon
      FROM places c
      JOIN places p ON p.qid = c.parent_qid
      WHERE c.merged_into IS NULL AND p.merged_into IS NULL
        AND c.lat IS NOT NULL AND c.lon IS NOT NULL
        AND p.lat IS NOT NULL AND p.lon IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM artists a
          JOIN track_artists ta ON ta.artist_id = a.spotify_id AND ta.position = 0
          WHERE ${ARTIST_PLACE} = c.qid
        )`);

    // Collaborations: two places credited on the same track. Deliberately drops
    // the `position = 0` restriction used everywhere else — the whole point is
    // the artists past the first, since a track with only a lead artist
    // connects nothing. `b.qid > a.qid` rules out self-pairs and yields each
    // pair once rather than twice.
    const collab = all(`
      WITH ap AS (
        SELECT a.spotify_id id, ${ARTIST_PLACE} qid FROM artists a
      ),
      tp AS (
        SELECT DISTINCT ta.track_id t, ap.qid
        FROM track_artists ta
        JOIN ap ON ap.id = ta.artist_id
        WHERE ap.qid IS NOT NULL
      )
      SELECT pa.qid a, pb.qid b, pa.lat alat, pa.lon alon, pb.lat blat, pb.lon blon,
             count(DISTINCT x.t) tracks
      FROM tp x
      JOIN tp y ON y.t = x.t AND y.qid > x.qid
      JOIN places pa ON pa.qid = x.qid AND pa.lat IS NOT NULL
      JOIN places pb ON pb.qid = y.qid AND pb.lat IS NOT NULL
      GROUP BY pa.qid, pb.qid
      ORDER BY tracks DESC`);

    return { nesting, collab };
  },

  /** Connection + index state, for the onboarding panel. */
  '/api/setup': async () => ({
    signedIn: Boolean(currentUserId()),
    user: currentUserId(),
    spotify: currentUserId() ? authStatus() : { connected: false },
    index: (await indexInfo()) ?? { kind: 'none' },
    hasLibrary: currentUserId() ? one('SELECT count(*) n FROM tracks').n > 0 : false,
  }),

  // Step one of the sign-in: hand the browser somewhere to go. The client
  // navigates to it rather than the server opening a browser, which only ever
  // worked when the server and the person were the same machine.
  '/api/auth/connect': () => ({ authUrl: beginAuth().url }),

  '/api/auth/disconnect': () => {
    disconnect();
    return { connected: false };
  },

  // Ends the browser session without touching the library or the tokens, so
  // signing back in does not mean importing again. Handled in the server below,
  // since it is the one other route that has to write a cookie header.
  '/api/auth/logout': () => ({ signedIn: false }),

  '/api/import': () => {
    if (importStatus().running) return importStatus();
    runImport().catch(() => {}); // errors surface through /api/import/status
    return importStatus();
  },

  '/api/import/status': () => importStatus(),
  '/api/import/cancel': () => ({ cancelling: cancelImport() }),

  /** Sources, with their covers — the library filter is built from this. */
  '/api/sources': () => ({
    sources: all(`
      SELECT s.id, s.kind, s.name, s.image_url, s.owned, s.note, s.track_total,
             s.last_synced_at,
             (SELECT count(*) FROM track_sources ts WHERE ts.source_id = s.id) imported
      FROM sources s
      ORDER BY (s.kind = 'liked') DESC, imported DESC, s.name COLLATE NOCASE`),
  }),

  /**
   * Preview then create a playlist from a place. Split in two on purpose: the
   * UI shows a count and a sample, and nothing is written to Spotify until an
   * explicit confirm — the same discipline the CLI used.
   */
  '/api/playlist-preview': (url) => {
    const qid = url.searchParams.get('placeQid');
    const iso = url.searchParams.get('iso');
    if (!qid && !iso) return { error: 'placeQid or iso required' };
    const rows = placeTracks({ qid, iso });
    return {
      total: rows.length,
      sample: rows.slice(0, 12).map((r) => ({ track: r.name, artist: r.artist, city: r.city })),
      places: [...new Set(rows.map((r) => r.city).filter(Boolean))].slice(0, 20),
    };
  },

  '/api/playlist-create': async (url, body) => {
    const { placeQid, iso, name } = body ?? {};
    if (!placeQid && !iso) return { error: 'placeQid or iso required' };
    const rows = placeTracks({ qid: placeQid, iso });
    const uris = [...new Set(rows.map((r) => r.uri).filter(Boolean))];
    if (!uris.length) return { error: 'nothing to add' };
    const playlist = await createPlaylist(name || `Mappify — ${rows[0]?.city ?? 'selection'}`, uris, {
      description: `Artists from ${name || rows[0]?.city || 'this place'} in my library. Built by Mappify.`,
    });
    return playlist;
  },

  // Flat place index, kept for grouping without nesting.
  /**
   * Places on the map, by name, for correcting where an artist is from.
   *
   * Only places that already carry coordinates are offered, since the point of
   * setting one is to move a dot — a place the globe cannot draw would silently
   * do nothing. Ordered by how much of the library is already there, so typing
   * "chi" puts Chicago above Chichester.
   */
  '/api/place-search': (url) => {
    const q = (url.searchParams.get('q') ?? '').trim();
    if (!q) return { places: [] };
    const places = all(
      `SELECT p.qid, p.name, p.country_iso,
              (SELECT count(*) FROM artists a WHERE ${ARTIST_PLACE} = p.qid) artists
         FROM places p
        WHERE p.lat IS NOT NULL AND p.merged_into IS NULL AND p.name LIKE ?
        ORDER BY artists DESC, length(p.name), p.name COLLATE NOCASE
        LIMIT 12`,
      `%${q}%`
    );
    return { places };
  },

  /**
   * Pin an artist to a place by hand, or clear the pin.
   *
   * Writes nothing to Spotify and nothing to MusicBrainz — it only overrides
   * what this library shows.
   */
  '/api/artist-origin': (url, body) => {
    const id = String(body?.spotifyId ?? '');
    if (!id) return { error: 'spotifyId required' };
    const qid = body?.placeQid ? String(body.placeQid) : null;
    if (qid && !one('SELECT 1 ok FROM places WHERE qid = ?', qid)) {
      return { error: 'no such place' };
    }
    db.prepare('UPDATE artists SET origin_override_qid = ? WHERE spotify_id = ?').run(qid, id);
    return { ok: true, spotifyId: id, placeQid: qid };
  },

  '/api/places': (url) => {
    const by = url.searchParams.get('by') === 'country' ? COUNTRY : CITY;
    const rows = all(`
      SELECT COALESCE(${by}, 'Unknown') place,
             count(DISTINCT ta.track_id) tracks,
             count(DISTINCT a.spotify_id) artists,
             max(a.mb_country_iso) iso
      FROM track_artists ta JOIN artists a ON a.spotify_id = ta.artist_id
      WHERE ta.position = 0
      GROUP BY place
      ORDER BY (place = 'Unknown'), tracks DESC, place`);
    return { places: rows };
  },
};

function readBody(req) {
  return new Promise((resolve) => {
    if (req.method !== 'POST') return resolve(null);
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/**
 * Routes reachable without a session.
 *
 * Deliberately a short allowlist rather than a list of protected routes: a new
 * route is private until someone decides otherwise, so forgetting to think about
 * it fails closed. `/api/setup` is here because the sign-in screen has to ask
 * something before anyone is signed in; it answers `signedIn: false` and touches
 * no library.
 */
const PUBLIC = new Set(['/api/setup', '/api/auth/connect', '/api/auth/callback']);

/**
 * The end of the OAuth flow, and the only route that writes a cookie.
 *
 * Answers in HTML rather than JSON: the browser arrives here as a top-level
 * navigation from accounts.spotify.com, so whatever comes back is what the
 * person reads.
 */
async function handleCallback(url, res) {
  const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
  body{background:#121212;color:#fff;font:14px system-ui,sans-serif;margin:0;
       display:flex;align-items:center;justify-content:center;height:100vh}
  div{background:#181818;border-radius:10px;padding:28px 36px;text-align:center;max-width:420px}
  h1{font-size:16px;margin:0 0 8px}p{margin:0;color:#b3b3b3;line-height:1.5}
  a{color:#1db954}
</style>
<div><h1>${title}</h1><p>${body}</p></div>`;

  const send = (status, html, cookie) => {
    const headers = { 'Content-Type': 'text/html; charset=utf-8' };
    if (cookie) headers['Set-Cookie'] = cookie;
    res.writeHead(status, headers).end(html);
  };

  const denied = url.searchParams.get('error');
  if (denied) {
    return send(400, page('Sign-in cancelled', `Spotify said: ${denied}. You can close this tab.`));
  }

  try {
    const { sessionId, displayName } = await completeAuth(
      url.searchParams.get('code'),
      url.searchParams.get('state')
    );
    send(
      200,
      page(
        `Hello${displayName ? `, ${displayName}` : ''}`,
        `You're connected. <a href="${WEB_ORIGIN}">Open Mappify</a>.`
      ),
      sessionCookie(sessionId)
    );
  } catch (err) {
    const message = String(err.message ?? err);
    // The five-user cap is the single most likely reason a new person cannot get
    // in, and Spotify's own wording for it reads like a bug in the app.
    send(400, page('Could not sign you in', allowlistHint(message) ?? message));
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, publicUrl());
  res.setHeader('Access-Control-Allow-Origin', WEB_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  // The session cookie only travels on cross-origin requests if both sides opt
  // in, and in development the web app is on a different port to this server.
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  if (url.pathname === '/api/auth/callback') return handleCallback(url, res);

  const handler = routes[url.pathname];
  if (!handler) {
    res.writeHead(404).end(JSON.stringify({ error: 'no such route', known: Object.keys(routes) }));
    return;
  }

  const userId = userForRequest(req);
  if (!userId && !PUBLIC.has(url.pathname)) {
    res.writeHead(401).end(JSON.stringify({ error: 'not signed in', signedIn: false }));
    return;
  }

  try {
    const body = await readBody(req);

    if (url.pathname === '/api/auth/logout') {
      endSession(req);
      res.writeHead(200, { 'Set-Cookie': clearCookie() }).end(JSON.stringify({ signedIn: false }));
      return;
    }

    // Everything below runs inside the caller's scope, which is what makes
    // currentDb() answer with their library and nobody else's. A public route
    // with no session runs outside any scope, so it cannot touch a database at
    // all — that is enforcement, not etiquette.
    const run = () => handler(url, body);
    const result = userId ? await runAsUser({ userId, db: openUserDb(userId) }, run) : await run();
    res.writeHead(200).end(JSON.stringify(result));
  } catch (err) {
    const message = String(err.message ?? err);
    res.writeHead(500).end(JSON.stringify({ error: message, hint: allowlistHint(message) }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`mappify api  ${publicUrl()}  (listening on ${HOST}:${PORT})`);
  console.log(`spotify redirect URI: ${REDIRECT_URI}`);
  console.log(`routes: ${Object.keys(routes).join('  ')}`);
});
