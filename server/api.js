// Local REST API over mappify.db. Plain node:http — no framework.
// Read-only for now; sync and export endpoints arrive with Phases 2 and 6.

import './env.js';
import { isLoopback } from './env.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openUserDb, hasFts, reindexArtist, DATA_DIR } from './db.js';
import { runAsUser, currentDb, currentUserId } from './context.js';
import {
  authStatus,
  beginAuth,
  completeAuth,
  disconnect,
  allowlistHint,
  publicUrl,
  hasClientId,
  setClientId,
  clientId,
  clientIdSource,
  REDIRECT_URI,
} from './auth.js';
import {
  userForRequest,
  endSession,
  sessionCookie,
  clearCookie,
  pendingAuth,
} from './session.js';
import { serveStatic, hasBuiltApp } from './static.js';
import { CITY, COUNTRY, ARTIST_PLACE, ARTIST_IMAGE, PLACE_SUBTREE } from './sql.js';
import { parseFilters, filterSql, filterTargets } from './filters.js';
import { artistMatch, friendArtistMatch, tokenise } from './search.js';
import {
  buildExport,
  encodeExport,
  exportFilename,
  decodeExport,
  saveFriend,
  listFriends,
  getFriend,
  friendAvatar,
  friendPoints,
  friendLibrary,
  myLibrary,
  deleteFriend,
  BadShareFile,
  PLAYLIST_FORMAT,
} from './share.js';
import { compareLibraries } from './compare.js';
import { runImport, status as importStatus, cancel as cancelImport, anyRunning } from './jobs.js';
import { beat, bye, armAutoQuit, graceMs } from './presence.js';
import { createPlaylist, me, fetchAvatarBytes } from './sources/spotify.js';
import { indexInfo } from './mbindex.js';

const PORT = Number(process.env.MAPPIFY_PORT ?? 6942);
// Where the app itself lives. In production it is this same server, so the
// default is our own public URL; tools/dev.js overrides it with the Vite port.
const WEB_ORIGIN = process.env.MAPPIFY_WEB ?? publicUrl();
// Loopback unless told otherwise. A hosted instance sets MAPPIFY_HOST=0.0.0.0,
// which is a decision to expose the thing and should have to be made on purpose.
const HOST = process.env.MAPPIFY_HOST ?? '127.0.0.1';
// Only reachable from this machine, which is what makes the first-run setup
// screen safe to expose without anyone being signed in yet. The rule lives in
// env.js because auth.js decides the same question about .env.
const LOOPBACK = isLoopback();

// Requests being served right now. The idle shutdown counts these as work, so it
// can never land in the middle of one — /api/playlist-create writes to somebody's
// Spotify account, and being halfway through that when the process exits is the
// kind of thing that is very hard to explain afterwards.
let inFlight = 0;

// Every query runs against whoever the request belongs to. There is no
// module-level database any more: the old `const db = openDb()` was the single
// object that made this server single-tenant, and reading from the async-scoped
// context is what stops a handler quietly serving the wrong library.
const all = (sql, ...params) => currentDb().prepare(sql).all(...params);
const one = (sql, ...params) => currentDb().prepare(sql).get(...params);

// Display values: MusicBrainz first, Wikidata as fallback. Both are kept in the
// DB; this only decides what the UI shows by default.

// CITY, COUNTRY, ARTIST_PLACE and PLACE_SUBTREE now live in sql.js, and the
// library filter that used to be `sourceFilter` here is filters.js — the search
// index has to answer "where is this artist from" exactly as the API does, and
// the chips have to mean the same thing in every view, so both definitions are
// shared rather than restated.

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

/**
 * The same question, asked of one imported library.
 *
 * Their artists carry a place and nothing above it — a shared file has no
 * containment tree — so the subtree has to be walked in *your* places and their
 * flat qids matched against the result. Selecting New York City therefore picks
 * up their Brooklyn artists as long as your own tree knows Brooklyn is in it,
 * which it does for every place either library has ever resolved.
 *
 * A place only they have still works, because the walk starts at the selected
 * qid whether or not you have a row for it: at worst it matches just itself,
 * which is exactly the case that used to offer an empty playlist.
 *
 * `mine` rides along so a preview can say how much of this is new to you, in the
 * same words the place panel already uses for their artists.
 */
function friendPlaceTracks({ friendId, qid, iso }) {
  const where = qid
    ? `COALESCE((SELECT m.merged_into FROM places m WHERE m.qid = fa.place_qid), fa.place_qid) IN (
         WITH RECURSIVE sub(qid) AS (
           SELECT ?
           UNION
           SELECT c.qid FROM places c JOIN sub
             ON COALESCE((SELECT m2.merged_into FROM places m2 WHERE m2.qid = c.parent_qid), c.parent_qid) = sub.qid
            WHERE c.merged_into IS NULL AND c.qid <> sub.qid
         ) SELECT qid FROM sub
       )`
    : 'fp.country_iso = ?';
  return all(
    `SELECT DISTINCT ft.spotify_id, ft.name, fa.name artist, fp.name city,
            EXISTS (SELECT 1 FROM tracks t WHERE t.spotify_id = ft.spotify_id) mine
       FROM friend_tracks ft
       JOIN friend_artists fa
         ON fa.friend_id = ft.friend_id AND fa.spotify_id = ft.artist_id
       LEFT JOIN friend_places fp
         ON fp.friend_id = fa.friend_id AND fp.qid = fa.place_qid
      WHERE ft.friend_id = ? AND ${where}
      ORDER BY fa.name COLLATE NOCASE, ft.name COLLATE NOCASE`,
    friendId,
    qid ?? iso
  );
}

/**
 * Every imported library that has anything at a place, with what it holds.
 *
 * Read by both playlist routes: the preview lists them as options and the
 * create route builds from the ones that were ticked, so what you were offered
 * and what you get are the same query.
 */
function sharedAtPlace({ qid, iso }) {
  return listFriends()
    .map((f) => ({ friend: f, rows: friendPlaceTracks({ friendId: f.id, qid, iso }) }))
    .filter((s) => s.rows.length);
}

/**
 * The library as a `.mappify` file, and the name it should have.
 *
 * Shared by the two routes that need it — one hands the bytes to the browser,
 * the other writes them to disk — because they must produce the same file. Two
 * copies of this would be two exports that could quietly drift apart.
 */
async function exportBytes() {
  const userId = currentUserId();
  // The display name is asked of Spotify rather than of the library, because the
  // library does not hold one — and the avatar comes back null on any failure
  // rather than costing somebody their export.
  let displayName = userId;
  try {
    displayName = (await me())?.display_name || userId;
  } catch {
    // Offline, or the token has expired. The file is still worth writing.
  }
  const avatar = await fetchAvatarBytes();
  const payload = buildExport({ spotifyId: userId, displayName, avatar });
  return { bytes: encodeExport(payload), ascii: exportFilename(displayName) };
}

/**
 * Write a file to the downloads folder, without ever landing on one that exists.
 *
 * Exporting twice in a day produces the same name twice, and silently replacing
 * the first file would destroy something somebody may have already sent. The
 * suffix is what the operating systems do themselves, for the same reason.
 *
 * Falls back to the data directory when there is no Downloads folder — a server
 * account, or a machine where it has been moved — because a path that exists is
 * worth more than the tidiest one.
 */
function writeToDownloads(name, bytes) {
  const home = os.homedir();
  const downloads = path.join(home, 'Downloads');
  const dir = fs.existsSync(downloads) ? downloads : DATA_DIR;

  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let file = path.join(dir, name);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${stem} (${n})${ext}`);

  fs.writeFileSync(file, bytes);
  return file;
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
    const F = filterSql(parseFilters(url));
    const SRC = F.join;

    const where = [];
    const params = [];
    if (q) {
      const m = artistMatch(q, hasFts(currentDb()));
      where.push(...m.clauses);
      params.push(...m.params);
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
      WHERE ${where.join(' AND ')}${F.where}
      ORDER BY tracks DESC, a.name COLLATE NOCASE
      LIMIT ? OFFSET ?`;
    // The chips' own parameters go last, because their clauses are appended
    // last — that is the whole reason filterSql keeps every `?` in `where`.
    const items = all(sql, ...params, ...F.params, limit, offset);
    const total = one(
      `SELECT count(*) n FROM artists a WHERE ${where.join(' AND ')}${F.where}`,
      ...params,
      ...F.params
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
    const F = filterSql(parseFilters(url));
    const SRC = F.join;
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
      WHERE ${ARTIST_PLACE} IS NOT NULL${F.where}
      GROUP BY ${ARTIST_PLACE}`, ...F.params);
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
      WHERE ${ARTIST_PLACE} IS NULL${F.where}
      GROUP BY city, iso`, ...F.params);

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
    const F = filterSql(parseFilters(url));
    const SRC = F.join;
    // Grouped by the surviving place, so Milan is one dot rather than two.
    const points = all(`
      SELECT s.qid, s.name, s.lat, s.lon, s.country_iso,
             count(DISTINCT ta.track_id)  tracks,
             count(DISTINCT a.spotify_id) artists
      FROM artists a
      JOIN places s ON s.qid = ${ARTIST_PLACE}
      JOIN track_artists ta ON ta.artist_id = a.spotify_id AND ta.position = 0${SRC}
      WHERE s.lat IS NOT NULL AND s.lon IS NOT NULL${F.where}
      GROUP BY s.qid
      ORDER BY tracks DESC`, ...F.params);
    // A filtered globe reports the tail it is actually hiding, so the hint and
    // the dots are counting the same library.
    const missing = one(`
      SELECT count(DISTINCT ta.track_id) tracks
      FROM artists a
      JOIN track_artists ta ON ta.artist_id = a.spotify_id AND ta.position = 0${SRC}
      WHERE (${ARTIST_PLACE} IS NULL
         OR ${ARTIST_PLACE} NOT IN (SELECT qid FROM places WHERE lat IS NOT NULL))${F.where}`,
      ...F.params);
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
    // Before a client ID exists there is no sign-in to offer, so the first
    // screen has to be the one that asks for it.
    needsClientId: !hasClientId(),
    // Shown in full so it can be compared against the dashboard: a client ID is
    // public by design under PKCE, and "is this the app I think it is" is the
    // question you need answered when sign-in fails.
    clientId: hasClientId() ? clientId() : null,
    // 'env' means this instance is configured by .env and the panel must not
    // offer a control that would be refused.
    clientIdSource: clientIdSource(),
    redirectUri: REDIRECT_URI,
    // Running on your own machine, where the person signing in is the person who
    // registered the app. The five-account warning is meaningless there, and
    // saying it anyway makes a private install sound like someone else's server.
    local: LOOPBACK,
    spotify: currentUserId() ? authStatus() : { connected: false },
    index: (await indexInfo()) ?? { kind: 'none' },
    hasLibrary: currentUserId() ? one('SELECT count(*) n FROM tracks').n > 0 : false,
  }),

  // Only from the machine it is running on. Reachable from outside, this would
  // let a stranger point somebody else's install at their own Spotify
  // application — which is the whole reason a hosted instance is sent to the
  // environment instead.
  //
  // `replace` distinguishes the first-run screen from a deliberate change, so
  // the former cannot silently overwrite a working app from a stale tab.
  '/api/config/client-id': (url, body) => {
    if (!LOOPBACK) throw new Error('Set SPOTIFY_CLIENT_ID in the environment on a hosted instance.');
    const id = setClientId(body?.clientId, { replace: Boolean(body?.replace) });
    return { clientId: id, redirectUri: REDIRECT_URI };
  },

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

  /**
   * Stop the application.
   *
   * A double-clickable build has no console to close, so without this the only
   * way to stop it is Task Manager — and closing the browser tab would leave a
   * server running invisibly for the rest of the session.
   *
   * Loopback only. That is the same trust boundary as being able to launch it:
   * someone at this machine. On a hosted instance the caller is not local and
   * this does nothing, which is what stops a visitor shutting down the host.
   */
  '/api/quit': () => {
    if (!LOOPBACK) throw new Error('This instance is not running locally.');
    setTimeout(() => process.exit(0), 150); // let the response finish first
    return { stopping: true };
  },

  // An open tab saying so. Cheap on purpose: no database, no session, no user —
  // it answers before anyone has signed in, because a tab sitting on the sign-in
  // screen is still a reason to stay up.
  '/api/alive': (url) => {
    if (!LOOPBACK) return { ok: false };
    beat(url.searchParams.get('tab'));
    return { ok: true, graceMs };
  },

  // Sent by sendBeacon as the tab goes. Only shortens that tab's window, since
  // this fires on a reload too — see presence.js.
  '/api/bye': (url) => {
    if (!LOOPBACK) return { ok: false };
    bye(url.searchParams.get('tab'));
    return { ok: true };
  },

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
    const mine = placeTracks({ qid, iso });
    const shared = sharedAtPlace({ qid, iso });
    // Which of them are ticked right now. The union is counted here rather than
    // in the browser because only this side holds the track ids to union *by* —
    // sending them all so the panel could count them itself would be the whole
    // playlist over the wire on every checkbox.
    const chosen = new Set(friendIds(url));
    const picked = shared.filter((s) => chosen.has(s.friend.id));
    const ids = new Set(mine.map((r) => r.spotify_id));
    // Yours first, then each library in turn, so a track you both have is
    // counted once and attributed to you.
    const extra = [];
    for (const s of picked)
      for (const r of s.rows)
        if (!ids.has(r.spotify_id)) {
          ids.add(r.spotify_id);
          extra.push({ ...r, who: s.friend.display_name });
        }
    const rows = [...mine, ...extra];
    // A few of theirs kept in the sample rather than yours filling it.
    // Straight `slice` off the front meant that at a place you have 200 tracks
    // from, ticking a library changed a number and nothing else on screen —
    // the twelve rows shown were all still your own.
    const fromMine = mine.slice(0, Math.max(12 - extra.length, 8));
    const shown = [...fromMine, ...extra.slice(0, 12 - fromMine.length)];
    return {
      total: rows.length,
      mine: mine.length,
      sample: shown.map((r) => ({
        track: r.name,
        artist: r.artist,
        city: r.city,
        // Only on a row that is not yours: the sample is mostly your own music
        // and naming you on every line of it says nothing.
        who: r.who ?? null,
      })),
      places: [...new Set(rows.map((r) => r.city).filter(Boolean))].slice(0, 20),
      /**
       * Which libraries this count is of. Echoed rather than assumed: the panel
       * ticks a box before the answer for it has landed, and without this it
       * would have to guess whether the number on screen is the old one.
       */
      included: picked.map((s) => s.friend.id),
      /** Every imported library with something here — ticked or not. */
      shared: shared.map((s) => ({
        id: s.friend.id,
        name: s.friend.display_name,
        tracks: s.rows.length,
        missing: s.rows.filter((r) => !r.mine).length,
      })),
    };
  },

  '/api/playlist-create': async (url, body) => {
    const { placeQid, iso, name } = body ?? {};
    if (!placeQid && !iso) return { error: 'placeQid or iso required' };
    const mine = placeTracks({ qid: placeQid, iso });
    // Ids rather than uris on their side: a shared file carries no uri, for the
    // same reason their tracks play through a uri the caller builds.
    const chosen = new Set(bodyFriendIds(body));
    const picked = chosen.size ? sharedAtPlace({ qid: placeQid, iso }).filter((s) => chosen.has(s.friend.id)) : [];
    const uris = [...new Set(mine.map((r) => r.uri).filter(Boolean))];
    const seen = new Set(uris);
    for (const s of picked)
      for (const r of s.rows) {
        const uri = `spotify:track:${r.spotify_id}`;
        if (!seen.has(uri)) {
          seen.add(uri);
          uris.push(uri);
        }
      }
    if (!uris.length) return { error: 'nothing to add' };
    const where = name || mine[0]?.city || picked[0]?.rows[0]?.city || 'this place';
    const from = picked.length
      ? `in my library and ${picked.map((s) => s.friend.display_name).join(', ')}'s`
      : 'in my library';
    const playlist = await createPlaylist(name || `Mappify — ${where}`, uris, {
      description: `Artists from ${where} ${from}. Built by Mappify.`,
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
   * One query, three kinds of answer: artists, places and playlists.
   *
   * What the search panel is built on. Everything it returns is something you
   * can turn into a filter chip, which is why places are here as places rather
   * than as the artists who happen to live in them — "not Italy" is a thing you
   * mean about a country, not about a list of people.
   *
   * Deliberately *not* narrowed by the chips already applied. You are looking
   * for the next thing to include or rule out, and hiding candidates because
   * they fall outside the current filter is how a filter becomes a cage.
   *
   * No track search: there is no index for track names, and building one over
   * the largest table in the database to answer a question nobody has asked yet
   * is not free. If it is ever wanted, it belongs next to `artist_search`.
   */
  '/api/search': (url) => {
    const q = (url.searchParams.get('q') ?? '').trim();
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 8), 20);
    const { scope, friends } = searchScope(url);

    // Sources, by name. LIKE rather than FTS: a library holds hundreds of
    // playlists, not hundreds of thousands, and `imported > 0` is the same rule
    // the old dropdown used — an un-owned playlist Spotify will not enumerate
    // exists here as a name with nothing behind it, and offering one hands you
    // a chip that silently empties the globe.
    const playlists = (pattern, n) =>
      all(
        `SELECT s.id, s.kind, s.name, s.image_url,
                (SELECT count(*) FROM track_sources ts WHERE ts.source_id = s.id) imported
           FROM sources s
          WHERE ${pattern ? 's.name LIKE ? AND ' : ''}
                (SELECT count(*) FROM track_sources ts WHERE ts.source_id = s.id) > 0
          ORDER BY (s.kind = 'liked') DESC, imported DESC, s.name COLLATE NOCASE
          LIMIT ?`,
        ...(pattern ? [pattern] : []),
        n
      );

    /**
     * Your own library, searched.
     *
     * A function rather than the straight-line code it used to be, because the
     * 'both' scope needs the same answer and restating this query is exactly how
     * the two would drift apart.
     */
    const mineResults = () => {
      const m = artistMatch(q, hasFts(currentDb()));
      const artists = m.clauses.length
        ? all(
            `SELECT a.spotify_id, a.name,
                    COALESCE((SELECT p3.name FROM places p3 WHERE p3.qid = a.origin_override_qid),
                             (SELECT p4.name FROM places p4 WHERE p4.qid = a.origin_wiki_qid),
                             ${CITY}) city,
                    ${ARTIST_PLACE} place_qid,
                    (SELECT count(*) FROM track_artists ta WHERE ta.artist_id = a.spotify_id) tracks,
                    ${ARTIST_IMAGE} image_url
               FROM artists a
              WHERE ${m.clauses.join(' AND ')}
              ORDER BY tracks DESC, a.name COLLATE NOCASE
              LIMIT ?`,
            ...m.params,
            limit
          )
        : [];

      // Every token has to appear in the name, so "new york" still finds New York
      // City. Only places the globe can actually draw: one without coordinates
      // cannot be a dot, so it cannot be a filter either.
      //
      // Counted over the subtree, not the place itself, because that is what
      // picking it would actually show — Greater London holds no artists of its
      // own and eighty-odd through the boroughs under it, and a row reading "0
      // artists" for a filter that yields eighty is a lie about what the click
      // does. Two queries deep so the walk runs for the handful of rows that
      // survive rather than for every place whose name matches.
      const tokens = tokenise(q);
      const named = tokens.length
        ? all(
            `SELECT p.qid, p.name, p.country_iso,
                    (SELECT count(*) FROM artists a WHERE ${ARTIST_PLACE} = p.qid) direct
               FROM places p
              WHERE p.lat IS NOT NULL AND p.merged_into IS NULL
                AND ${tokens.map(() => 'p.name LIKE ?').join(' AND ')}
              ORDER BY direct DESC, length(p.name), p.name COLLATE NOCASE
              LIMIT ?`,
            ...tokens.map((tok) => `%${tok}%`),
            limit * 2
          )
        : [];
      const places = named
        .map((p) => {
          const n = one(
            `SELECT count(DISTINCT a.spotify_id) artists,
                    count(DISTINCT ta.track_id)  tracks
               FROM artists a
               JOIN track_artists ta ON ta.artist_id = a.spotify_id AND ta.position = 0
              WHERE ${PLACE_SUBTREE}`,
            p.qid
          );
          return { qid: p.qid, name: p.name, country_iso: p.country_iso, ...n };
        })
        // A place nothing in the library comes from is a chip that empties the
        // globe. It is still a real place; it is just not one of yours.
        .filter((p) => p.artists > 0)
        .sort((a, b) => b.artists - a.artists || a.name.length - b.name.length)
        .slice(0, limit);

      // Labelled even though this is the only source in the default scope: if
      // only friend rows carried an owner, yours would be identified by the
      // absence of a field, which is not something a reader should have to know.
      return { artists: artists.map((r) => ({ ...r, owner: 'mine' })),
               places: places.map((r) => ({ ...r, owner: 'mine' })) };
    };

    // Nothing typed yet: the panel's resting state is your library, which is
    // what the source dropdown used to be for. Under a scope of theirs it is
    // their playlists and the places they are deepest in — the two things a
    // shared library now has to rest on. Their places were the whole of it while
    // a file carried no playlists; see `friendTopPlaces`.
    if (!q) {
      return {
        artists: [],
        places: scope === 'mine' ? [] : friends.flatMap((id) => friendTopPlaces(id, 20)),
        playlists: [
          ...(scope === 'theirs' ? [] : playlists(null, 20)),
          ...(scope === 'mine' ? [] : friends.flatMap((id) => friendPlaylists(id, null, 20))),
        ],
        ...scopeNotes(scope, friends),
      };
    }

    if (scope !== 'mine') {
      // Every visible library, concatenated in the order they are drawn — the
      // same order their rings stack in, so the list and the globe agree.
      const each = friends.map((id) => friendResults(id, q, limit));
      const theirs = {
        artists: each.flatMap((r) => r.artists),
        places: each.flatMap((r) => r.places),
        playlists: friends.flatMap((id) => friendPlaylists(id, `%${q}%`, limit)),
      };
      if (scope === 'theirs') {
        return { ...theirs, ...scopeNotes(scope, friends) };
      }
      // 'both': yours first within each kind, because it is the library you can
      // actually act on — a friend row can be looked at, flown to and now opened,
      // but it cannot become a filter chip on your own globe.
      const mine = mineResults();
      return {
        artists: [...mine.artists, ...theirs.artists].slice(0, limit * 2),
        places: [...mine.places, ...theirs.places].slice(0, limit * 2),
        playlists: [...playlists(`%${q}%`, limit), ...theirs.playlists].slice(0, limit * 2),
        ...scopeNotes(scope, friends),
      };
    }

    return {
      ...mineResults(),
      playlists: playlists(`%${q}%`, limit),
      ...scopeNotes(scope, friends),
    };
  },

  /**
   * The names behind a set of chips.
   *
   * Chips travel in the URL as bare ids, so that a shared link cannot carry a
   * playlist name that has since been renamed. This is how the panel turns them
   * back into something readable. An id nothing matches is simply absent, and
   * the client shows the raw id — a deleted playlist should look odd, not crash.
   */
  '/api/filter-labels': (url) => {
    const f = parseFilters(url);
    const labels = {};
    const lookup = (targets, sql, key) => {
      for (const id of targets) {
        const row = one(sql, id);
        if (row?.name) labels[`${key}:${id}`] = row.name;
      }
    };
    for (const mode of ['include', 'exclude']) {
      lookup(f[mode].places, 'SELECT name FROM places WHERE qid = ?', 'place');
      lookup(f[mode].sources, 'SELECT name FROM sources WHERE id = ?', 'playlist');
      lookup(f[mode].artists, 'SELECT name FROM artists WHERE spotify_id = ?', 'artist');
    }
    // `limits` rides along because this is the one call the panel makes whenever
    // there are chips at all, and it is where a truncated filter can be told
    // about. Without it the caps in filters.js would drop chips with the URL
    // still listing them and nothing on screen to say so.
    return { labels, targets: filterTargets(f), limits: f.limits };
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
    // currentDb(), not a module-level `db` — there is no such binding any more,
    // which is why every pin used to 500 on the way out.
    currentDb().prepare('UPDATE artists SET origin_override_qid = ? WHERE spotify_id = ?').run(qid, id);
    // The search index is built from the resolved place, so a pin that does not
    // reach it leaves the artist findable by the birthplace you just corrected
    // away from. One row, rather than rebuilding the whole index for a click.
    reindexArtist(currentDb(), id);
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

  // --- sharing -------------------------------------------------------------
  //
  // Flat hyphenated names, like every route above: the table is keyed on the
  // exact pathname, so `/api/friends/12` cannot exist and a slashed name would
  // advertise a hierarchy the router does not have.
  //
  // None of these are in PUBLIC, and /api/export is the reason that matters —
  // it emits the whole library in one GET, and a hosted instance binds
  // 0.0.0.0. Default-private is the only thing standing in front of it.

  /**
   * The file, written where the person running this can find it.
   *
   * A downloaded Mappify opens in a Chromium app window: no downloads bar, no
   * bubble, no menu. `<a download>` there saves the file and says nothing, so
   * the button reads as broken and the export reads as missing. Writing it
   * ourselves and answering with the path is the only version of this that the
   * app window can actually tell you about.
   *
   * Loopback only, for the reason /api/export is not public: this writes to the
   * filesystem of the machine running the server, which on a hosted copy is not
   * the machine of the person asking.
   */
  '/api/export-file': async () => {
    if (!LOOPBACK) throw Object.assign(new Error('Not available on a hosted copy.'), { status: 400 });
    const { bytes, ascii } = await exportBytes();
    const path = writeToDownloads(ascii, bytes);
    return { path };
  },

  '/api/export': async () => {
    const { bytes, ascii } = await exportBytes();

    return {
      $raw: {
        headers: {
          // Not application/gzip, and above all not Content-Encoding: gzip —
          // that would have the browser transparently inflate the file and save
          // a .mappify full of plain JSON, which then fails its own gzip check
          // on import while looking perfectly fine on disk.
          'Content-Type': 'application/octet-stream',
          'Content-Disposition':
            `attachment; filename="${ascii}"; ` +
            `filename*=UTF-8''${encodeURIComponent(ascii)}`,
          'Content-Length': bytes.length,
          'Cache-Control': 'no-store',
        },
        body: bytes,
      },
    };
  },

  '/api/friends': () => ({ friends: listFriends() }),

  '/api/friend': (url) => {
    const id = friendId(url);
    const friend = getFriend(id);
    if (!friend) throw badRequest('no such friend');
    return { friend, points: friendPoints(id) };
  },

  /** The body is the file itself — see BINARY below. */
  '/api/friend-import': (url, body) => {
    if (!Buffer.isBuffer(body) || !body.length) throw new BadShareFile('No file was sent.');
    // Importing your own export is deliberately allowed: it is how you check
    // that the file you are about to send says what you think it says, and it is
    // the one comparison whose answer is known in advance.
    const decoded = decodeExport(body);
    const friend = saveFriend(decoded);
    return { ok: true, friend, skipped: decoded.dropped };
  },

  '/api/friend-delete': (url, body) => {
    const id = Number(body?.id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('which friend?');
    deleteFriend(id);
    return { ok: true };
  },

  '/api/friend-avatar': (url) => {
    const row = friendAvatar(friendId(url));
    if (!row?.bytes) throw badRequest('no avatar');
    return {
      $raw: {
        headers: {
          // The sniffed type from import, never the one the file claimed. The
          // two hardening headers are here because this is the one route that
          // serves bytes a stranger chose, from this origin.
          'Content-Type': row.mime,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'",
          'Cache-Control': 'private, max-age=86400',
        },
        body: Buffer.from(row.bytes),
      },
    };
  },

  /**
   * Their artists from one place, which is how the panel now lists them.
   *
   * A flat list of somebody's tracks is not how this app shows music anywhere
   * else: your own places list artists, and an artist opens onto the tracks
   * underneath. Theirs read as a different kind of thing purely because they
   * were shaped differently, so they are shaped the same way here.
   *
   * The totals come back with the artists so the section can say "N here · M you
   * don't have" without loading every track to count them — the whole point of
   * grouping is that the tracks arrive only when a row is opened.
   */
  '/api/friend-place-artists': (url) => {
    const id = friendId(url);
    if (!getFriend(id)) throw badRequest('no such friend');
    const qid = url.searchParams.get('qid');
    if (!qid) throw badRequest('which place?');
    // The exact place, with no subtree walk — see the note on the route above:
    // an imported library keys place on the artist and has no parent chain, so
    // there is nothing to roll a country up from.
    const artists = all(
      `SELECT fa.spotify_id, fa.name, fa.image_url,
              (SELECT count(*) FROM friend_tracks ft
                WHERE ft.friend_id = fa.friend_id AND ft.artist_id = fa.spotify_id) tracks,
              -- Per artist, so a row can say what is new in it before it is opened.
              (SELECT count(*) FROM friend_tracks ft
                WHERE ft.friend_id = fa.friend_id AND ft.artist_id = fa.spotify_id
                  AND NOT EXISTS (SELECT 1 FROM tracks t WHERE t.spotify_id = ft.spotify_id)) missing
         FROM friend_artists fa
        WHERE fa.friend_id = ? AND fa.place_qid = ?
        ORDER BY tracks DESC, fa.name COLLATE NOCASE`,
      id,
      qid
    );
    const totals = one(
      `SELECT count(*) tracks,
              sum(CASE WHEN EXISTS (SELECT 1 FROM tracks t WHERE t.spotify_id = ft.spotify_id)
                       THEN 0 ELSE 1 END) missing
         FROM friend_tracks ft
         JOIN friend_artists fa
           ON fa.friend_id = ft.friend_id AND fa.spotify_id = ft.artist_id
        WHERE ft.friend_id = ? AND fa.place_qid = ?`,
      id,
      qid
    );
    return { artists, tracks: totals.tracks, missing: totals.missing ?? 0 };
  },

  /**
   * Something to play from a place only they have.
   *
   * `/api/place-track` reads your own library, so a city you do not have answers
   * with nothing and the player stays silent — which made their dots the only
   * ones on the globe that did nothing when clicked. This is the same question
   * asked of an imported library.
   *
   * No `uri` in the row because a shared file has none; the caller builds
   * `spotify:track:<id>`, as everything else that plays their music does.
   */
  '/api/friend-place-track': (url) => {
    const id = friendId(url);
    if (!getFriend(id)) throw badRequest('no such friend');
    const qid = url.searchParams.get('qid');
    if (!qid) throw badRequest('which place?');
    const track = one(
      `SELECT ft.spotify_id, ft.name, fa.name artist
         FROM friend_tracks ft
         JOIN friend_artists fa
           ON fa.friend_id = ft.friend_id AND fa.spotify_id = ft.artist_id
        WHERE ft.friend_id = ? AND fa.place_qid = ?
        ORDER BY random() LIMIT 1`,
      id,
      qid
    );
    return track ?? { error: 'no track for that place' };
  },

  /** One of their artists, opened: the tracks under it and which you lack. */
  '/api/friend-artist-tracks': (url) => {
    const id = friendId(url);
    if (!getFriend(id)) throw badRequest('no such friend');
    const artist = url.searchParams.get('artist');
    if (!artist) throw badRequest('which artist?');
    return {
      tracks: all(
        // idx_ft_artist (friend_id, artist_id) covers this exactly.
        `SELECT ft.spotify_id, ft.name,
                EXISTS (SELECT 1 FROM tracks t WHERE t.spotify_id = ft.spotify_id) mine
           FROM friend_tracks ft
          WHERE ft.friend_id = ? AND ft.artist_id = ?
          ORDER BY ft.name COLLATE NOCASE`,
        id,
        artist
      ),
    };
  },

  /**
   * One of their playlists, opened.
   *
   * The one row in a shared library that can be *entered* rather than looked at:
   * a friend's artist opens onto a page that reads your library, and their place
   * is a coordinate, but their playlist is a list of tracks and every one of
   * them plays through the same `spotify:track:` the rest of their music does.
   *
   * Alphabetical, and not by accident: `track_sources` has no position column on
   * either side of the wire and `added_at` deliberately does not travel, so
   * there is no original order to restore. Inventing one — insertion order, say
   * — would be presenting an artefact of the export as somebody's sequencing.
   *
   * Capped, because their Liked Songs is their whole library. `shown` against
   * `playlist.tracks` is what lets the panel say a list is not all of it.
   */
  '/api/friend-playlist-tracks': (url) => {
    const id = friendId(url);
    if (!getFriend(id)) throw badRequest('no such friend');
    const source = Number(url.searchParams.get('source'));
    if (!Number.isInteger(source)) throw badRequest('which playlist?');
    const playlist = one(
      `SELECT source_id, kind, name, image_url, tracks
         FROM friend_sources WHERE friend_id = ? AND source_id = ?`,
      id,
      source
    );
    if (!playlist) throw badRequest('no such playlist');
    const tracks = all(
      // LEFT JOIN on the artist: friend_tracks.artist_id is nullable and
      // validated separately, so an unattributable track keeps its name here
      // instead of vanishing out of the middle of a playlist.
      `SELECT ft.spotify_id, ft.name, fa.name artist,
              EXISTS (SELECT 1 FROM tracks t WHERE t.spotify_id = ft.spotify_id) mine
         FROM friend_track_sources fts
         JOIN friend_tracks ft
           ON ft.friend_id = fts.friend_id AND ft.spotify_id = fts.track_id
         LEFT JOIN friend_artists fa
           ON fa.friend_id = ft.friend_id AND fa.spotify_id = ft.artist_id
        WHERE fts.friend_id = ? AND fts.source_id = ?
        ORDER BY ft.name COLLATE NOCASE
        LIMIT 500`,
      id,
      source
    );
    // Counted over the whole playlist rather than over the page of it above: a
    // heading that said "4 you don't have" about the first 500 of 1,990 would be
    // answering a question nobody asked.
    const missing = one(
      `SELECT count(*) n
         FROM friend_track_sources fts
        WHERE fts.friend_id = ? AND fts.source_id = ?
          AND NOT EXISTS (SELECT 1 FROM tracks t WHERE t.spotify_id = fts.track_id)`,
      id,
      source
    ).n;
    return { playlist: { ...playlist, missing }, tracks, shown: tracks.length };
  },

  '/api/compare': (url) => {
    const id = friendId(url);
    const friend = getFriend(id);
    if (!friend) throw badRequest('no such friend');
    return { friend, report: compareLibraries(myLibrary(), friendLibrary(id)) };
  },

  /**
   * What one collaboration arc on the globe is made of.
   *
   * The arcs come from `/api/links`, which only ever says *that* two places
   * share tracks and never which — so this is the other half of a line you can
   * see: the tracks crediting artists from both ends, and which artist is from
   * which end.
   *
   * The pair is unordered, exactly as it is on the globe. `/api/links` emits
   * each pair once with `b.qid > a.qid`, but a click has no reason to know that,
   * so this normalises rather than demanding a convention the caller cannot see.
   *
   * Deliberately mirrors the collab query in `/api/links`: `position` is ignored
   * — the whole point is the artists past the first, since a track with only a
   * lead artist connects nothing — and `ARTIST_PLACE` resolves both ends, so an
   * artist you have pinned by hand appears on the side you put them.
   */
  '/api/collab': (url) => {
    const a = url.searchParams.get('a');
    const b = url.searchParams.get('b');
    if (!/^Q\d+$/.test(a ?? '') || !/^Q\d+$/.test(b ?? '')) throw badRequest('two place qids');
    if (a === b) throw badRequest('a place does not collaborate with itself');

    const place = (qid) => one('SELECT qid, name, country_iso FROM places WHERE qid = ?', qid);
    const pa = place(a);
    const pb = place(b);
    if (!pa || !pb) throw badRequest('no such place');

    // Every credited artist on every track that has someone from both ends. The
    // INTERSECT is what "both" means; doing it in SQL rather than in JS keeps
    // the row set to the tracks that actually qualify.
    const rows = all(
      `WITH ap AS (
         SELECT a.spotify_id id, a.name, ${ARTIST_PLACE} qid FROM artists a
       ),
       shared AS (
         SELECT ta.track_id t FROM track_artists ta JOIN ap ON ap.id = ta.artist_id
          WHERE ap.qid = ?
         INTERSECT
         SELECT ta.track_id FROM track_artists ta JOIN ap ON ap.id = ta.artist_id
          WHERE ap.qid = ?
       )
       SELECT t.spotify_id, t.name, t.album, t.uri, t.url, t.image_url,
              ap.id artist_id, ap.name artist, ap.qid,
              ta.position
         FROM shared s
         JOIN tracks t ON t.spotify_id = s.t
         JOIN track_artists ta ON ta.track_id = s.t
         JOIN ap ON ap.id = ta.artist_id AND ap.qid IN (?, ?)
        ORDER BY t.name COLLATE NOCASE, ta.position`,
      a,
      b,
      a,
      b
    );

    // Grouped here rather than with group_concat: the artists carry ids the
    // panel turns into links, and packing those into a string only to split it
    // again is how a name containing a comma becomes two artists.
    const byTrack = new Map();
    const artistIds = new Set();
    for (const r of rows) {
      let t = byTrack.get(r.spotify_id);
      if (!t) {
        t = {
          spotify_id: r.spotify_id,
          name: r.name,
          album: r.album,
          uri: r.uri,
          url: r.url,
          image_url: r.image_url,
          artists: [],
        };
        byTrack.set(r.spotify_id, t);
      }
      t.artists.push({ spotify_id: r.artist_id, name: r.artist, qid: r.qid });
      artistIds.add(r.artist_id);
    }

    return {
      a: pa,
      b: pb,
      tracks: [...byTrack.values()],
      artistCount: artistIds.size,
    };
  },
};

/**
 * Which libraries a search covers.
 *
 * Defaults to 'mine', so every existing caller and every old link behaves as it
 * did. A friend scope naming a friend who is not there falls back to your own
 * library rather than throwing: that is what a stale link looks like after a
 * friend has been removed, and it is not worth an error page.
 */
function searchScope(url) {
  const raw = url.searchParams.get('scope');
  // Several ids now, because several libraries can be on the globe at once and
  // "theirs" has to mean all of them rather than whichever one is open. One
  // repeated `friend` parameter, so a single id is still a valid request and
  // every old link keeps working.
  const ids = url.searchParams
    .getAll('friend')
    .flatMap((raw) => raw.split(','))
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .filter((id) => getFriend(id));
  const scope = raw === 'theirs' || raw === 'both' ? raw : 'mine';
  if (scope === 'mine' || !ids.length) return { scope: 'mine', friends: [] };
  return { scope, friends: ids };
}

/**
 * What the panel has to say out loud about the scope it is in.
 *
 * Only ever about what is absent *by design*, never about what merely found
 * nothing. An empty playlist list under a friend scope would otherwise read as
 * "no playlist of theirs matches" — and there are now two different truths it
 * could be hiding, which is why this says which.
 *
 * A library imported from a format 1 file *could not* carry playlists: nothing
 * is wrong with it, and there is something to do about it, which is to ask for
 * a fresh file. A format 2 library with none simply has none. The first is the
 * one worth reporting, so it wins when both are true of different libraries.
 *
 * Silent once playlists are actually there — an empty list then really is a
 * search that matched nothing, and the empty state says so.
 */
function scopeNotes(scope, friends) {
  if (scope === 'mine') return { scope: 'mine', friends: [] };
  const rows = friends.map(getFriend).filter(Boolean);
  const old = rows.filter((f) => (f.format ?? 1) < PLAYLIST_FORMAT);
  if (old.length) {
    return {
      scope,
      friends,
      unavailable: {
        playlists:
          old.length === 1
            ? `${old[0].display_name}'s library was shared before playlists travelled in a file. A new one from them would carry them.`
            : `${old.length} of these libraries were shared before playlists travelled in a file.`,
      },
    };
  }
  if (rows.length && rows.every((f) => !f.playlists)) {
    return {
      scope,
      friends,
      unavailable: {
        playlists:
          rows.length === 1
            ? `${rows[0].display_name} shared no playlists — only Liked Songs and playlists somebody made themselves travel.`
            : 'None of these libraries shared any playlists.',
      },
    };
  }
  return { scope, friends };
}

/**
 * An imported library, searched.
 *
 * Rows carry `owner: 'theirs'`, and yours carry `owner: 'mine'`, so a merged
 * list says where each row came from rather than leaving it to be inferred.
 *
 * The place counts here are the friend's own totals for that place and nothing
 * beneath it. Their places arrive as a flat list with no parent chain, so unlike
 * the query over your own library there is no subtree to roll up — which is a
 * real difference in what the number means, and the reason the panel labels
 * these rows rather than mixing them in silently.
 */
function friendResults(friendId, q, limit) {
  if (friendId == null) return { artists: [], places: [] };

  const m = friendArtistMatch(q);
  const artists = m.clauses.length
    ? all(
        `SELECT fa.spotify_id, fa.name,
                (SELECT fp.name FROM friend_places fp
                  WHERE fp.friend_id = fa.friend_id AND fp.qid = fa.place_qid) city,
                fa.place_qid, fa.tracks, fa.image_url
           FROM friend_artists fa
          WHERE fa.friend_id = ? AND ${m.clauses.join(' AND ')}
          ORDER BY fa.tracks DESC, fa.name COLLATE NOCASE
          LIMIT ?`,
        friendId,
        ...m.params,
        limit
      )
    : [];

  const tokens = tokenise(q);
  const places = tokens.length
    ? all(
        `SELECT qid, name, country_iso, tracks, artists
           FROM friend_places
          WHERE friend_id = ? AND ${tokens.map(() => 'name LIKE ?').join(' AND ')}
          ORDER BY tracks DESC, length(name), name COLLATE NOCASE
          LIMIT ?`,
        friendId,
        ...tokens.map((tok) => `%${tok}%`),
        limit
      )
    : [];

  // The id travels on the row: with several libraries in one list, "theirs" no
  // longer identifies anything, and the panel needs to know whose colour to put
  // beside a name.
  const theirs = (row) => ({ ...row, owner: 'theirs', friend_id: friendId });
  return { artists: artists.map(theirs), places: places.map(theirs) };
}

/**
 * Their playlists, in the same shape as your own.
 *
 * Same column names as `playlists()` above — `id`, `kind`, `name`, `image_url`,
 * `imported` — so one row type serves both lists and the panel needs no second
 * shape for a friend's. `id` is their file's own source id, which is why the row
 * carries `friend_id`: the two numbers are only an address together.
 *
 * `tracks` is the count derived at import from the memberships that actually
 * arrived, never the number the file claimed. Liked Songs first, then by size —
 * the biggest thing in a library is the likeliest thing to be looked for in it.
 *
 * Only libraries from a format 2 file have any of this; older ones have no rows
 * here at all, which is what `scopeNotes` explains rather than leaving as a
 * silence that reads like a failed search.
 */
function friendPlaylists(friendId, like, limit) {
  if (friendId == null) return [];
  return all(
    `SELECT source_id id, kind, name, image_url, tracks imported
       FROM friend_sources
      WHERE friend_id = ? AND (? IS NULL OR name LIKE ?)
      ORDER BY (kind = 'liked') DESC, tracks DESC, name COLLATE NOCASE
      LIMIT ?`,
    friendId,
    like,
    like,
    limit
  ).map((row) => ({ ...row, owner: 'theirs', friend_id: friendId }));
}

/**
 * A friend's library with nothing typed into the box.
 *
 * The resting state for your own library is your playlists — things you can chip
 * without having to know a name. Theirs now rest on their playlists too, which
 * is what `friendPlaylists` above is for; this is the other half of that list.
 *
 * Places rather than artists, because of what a row can do. A friend's artist
 * can be neither chipped nor opened — chips filter your globe and the artist
 * page reads your library — so a list of them is a list of disabled buttons.
 * A place can be flown to whoever it belongs to, which makes their places the
 * one part of a shared library worth offering before a search narrows it.
 *
 * Ordered by artists rather than tracks: this is a list to pick a place off,
 * and how much of their library comes from somewhere is the better answer to
 * "which of these is worth a look" than how many tracks it adds up to.
 *
 * Coordinates required, for the same reason the query over your own places
 * demands them — a place the globe cannot draw is a row that cannot be flown to.
 */
function friendTopPlaces(friendId, limit) {
  if (friendId == null) return [];
  return all(
    `SELECT qid, name, country_iso, tracks, artists
       FROM friend_places
      WHERE friend_id = ? AND lat IS NOT NULL
      ORDER BY artists DESC, tracks DESC, name COLLATE NOCASE
      LIMIT ?`,
    friendId,
    limit
  ).map((row) => ({ ...row, owner: 'theirs' }));
}

/**
 * A caller's mistake, told apart from a fault in here.
 *
 * Without this every malformed id came back as a 500, which reads in the console
 * as "the server broke" when what happened is that it was asked for friend
 * number `abc`.
 */
function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** The `?id=`/`?friend=` a share route was called with, or a refusal. */
function friendId(url) {
  const raw = url.searchParams.get('id') ?? url.searchParams.get('friend');
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('which friend?');
  return id;
}

/**
 * Several libraries, from a repeated `?friend=` — the shape `searchScope` reads.
 *
 * Unlike `friendId` this never throws: a playlist scope with no library named
 * is the ordinary case, and an id that is not a library any more is dropped
 * rather than failing the request. Both routes intersect what they are given
 * with the libraries that actually have tracks at the place, so an id from a
 * stale tab can only ever ask for nothing.
 */
const friendIds = (url) => url.searchParams.getAll('friend').map(Number).filter(Number.isInteger);

/** The same list arriving in a POST body. */
const bodyFriendIds = (body) =>
  Array.isArray(body?.friends) ? body.friends.map(Number).filter(Number.isInteger) : [];

/** No JSON route here needs a fraction of this. */
const MAX_JSON_BODY = 1 << 20;

/** A 30,000-track library exports to about 2MB, so this is roomy on purpose. */
const MAX_UPLOAD = 16 << 20;

/** Routes whose body is a file rather than an object. */
const BINARY = new Set(['/api/friend-import']);

/**
 * The request body, as an object or as bytes.
 *
 * The bytes are not a nicety. This used to accumulate chunks into a string —
 * `raw += c` on a Buffer is a UTF-8 decode — and gzip is not valid UTF-8, so
 * every invalid sequence became U+FFFD and an uploaded file arrived quietly
 * destroyed, with the corruption looking like a fault in whoever *wrote* the
 * file. Chunks are kept as Buffers and joined once.
 *
 * The limit is not a nicety either: before it, a POST of any size was buffered
 * into memory in full.
 */
function readBody(req, { raw = false, limit = MAX_JSON_BODY } = {}) {
  return new Promise((resolve, reject) => {
    if (req.method !== 'POST') return resolve(null);
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) {
        req.destroy();
        reject(Object.assign(new Error('That file is too large.'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (raw) return resolve(buf);
      // Unparseable JSON still resolves to {}, as it always has: handlers
      // validate their own fields and say something more useful than this could.
      try {
        resolve(buf.length ? JSON.parse(buf.toString('utf8')) : {});
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
const PUBLIC = new Set([
  '/api/setup',
  '/api/auth/connect',
  '/api/auth/callback',
  '/api/config/client-id',
  // Quitting has to work from the sign-in screen too, before anyone has a
  // session. Its own guard is that the request came from this machine.
  '/api/quit',
  // Same reasoning: a tab is a tab whether or not anyone has signed in yet.
  '/api/alive',
  '/api/bye',
]);

/**
 * The end of the OAuth flow, and the only route that writes a cookie.
 *
 * Answers in HTML rather than JSON: the browser arrives here as a top-level
 * navigation from accounts.spotify.com, so whatever comes back is what the
 * person reads.
 */
async function handleCallback(url, res, req) {
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
    // A single-use state that has already been redeemed is not a failure when
    // this browser is holding the session that redeeming it produced — it is the
    // same sign-in arriving twice. Reporting "could not sign you in" to somebody
    // who *is* signed in sends them back round a loop they have already
    // finished, so answer with where they were going.
    if (err?.code === 'stale_link' && userForRequest(req)) {
      return send(
        200,
        page('Already signed in', `You're connected. <a href="${WEB_ORIGIN}">Open Mappify</a>.`)
      );
    }
    const message = String(err.message ?? err);
    // A stale link with no session behind it is a real dead end, but a
    // recoverable one — the way out is to start the flow again, so say where.
    if (err?.code === 'stale_link') {
      return send(
        400,
        page('Could not sign you in', `${message} <a href="${WEB_ORIGIN}">Open Mappify</a>.`)
      );
    }
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

  if (url.pathname === '/api/auth/callback') return handleCallback(url, res, req);

  const handler = routes[url.pathname];
  if (!handler) {
    // Anything that is not an API route is the web app, when there is one built.
    // Kept below the route table so a typo in an /api path still says so rather
    // than silently returning index.html and looking like a client bug.
    if (!url.pathname.startsWith('/api/') && serveStatic(req, res, url.pathname)) return;
    res.writeHead(404).end(JSON.stringify({ error: 'no such route', known: Object.keys(routes) }));
    return;
  }

  const userId = userForRequest(req);
  if (!userId && !PUBLIC.has(url.pathname)) {
    res.writeHead(401).end(JSON.stringify({ error: 'not signed in', signedIn: false }));
    return;
  }

  inFlight++;
  try {
    const body = await readBody(
      req,
      BINARY.has(url.pathname) ? { raw: true, limit: MAX_UPLOAD } : undefined
    );

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

    // A handler with bytes rather than an object says so, and every other
    // handler keeps the shape it has: (url, body) => plain object. The
    // alternative was intercepting each binary route above the table the way
    // /api/auth/callback is intercepted, which is how this file would grow a
    // second dispatcher one route at a time.
    //
    // writeHead's headers override the blanket application/json set at the top
    // of the request, so that line is left alone.
    if (result?.$raw) {
      const { status = 200, headers, body: bytes } = result.$raw;
      res.writeHead(status, headers).end(bytes);
      return;
    }
    res.writeHead(200).end(JSON.stringify(result));
  } catch (err) {
    const message = String(err.message ?? err);
    // A refused share file is the caller's problem, not a server fault: it gets
    // the sentence share.js wrote and a status that says "you sent me that".
    const status = err.name === 'BadShareFile' ? 400 : Number(err.status) || 500;
    res.writeHead(status).end(JSON.stringify({ error: message, hint: allowlistHint(message) }));
  } finally {
    inFlight--;
  }
});

// Stop when the last tab goes. Only locally — a hosted copy serves people who
// did not start it. MAPPIFY_AUTOQUIT=0 turns it off, which is what `npm run dev`
// does: there the API is one half of a pair, and it exiting would take Vite with
// it every time you closed a tab.
if (LOOPBACK && process.env.MAPPIFY_AUTOQUIT !== '0') {
  armAutoQuit({
    // A sign-in in flight counts as work: the tab has navigated to Spotify and
    // said goodbye on its way out, so nothing else here knows anyone is coming
    // back.
    isBusy: () => anyRunning() || inFlight > 0 || pendingAuth(),
    onQuit: () => {
      console.log('no browser tab for a while — stopping');
      process.exit(0); // 0, or quitting leaves an error on the console behind it
    },
  });
}

server.listen(PORT, HOST, () => {
  console.log(`mappify api  ${publicUrl()}  (listening on ${HOST}:${PORT})`);
  console.log(`spotify redirect URI: ${REDIRECT_URI}`);
  console.log(
    hasBuiltApp()
      ? 'serving the built web app from web/dist'
      : 'no web/dist — API only (npm run build to serve the app from here)'
  );
});
