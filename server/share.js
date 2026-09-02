// Your library as a file, and somebody else's file as a friend.
//
// Two halves that have to agree, so they live together: `buildExport` writes the
// format and `decodeExport` reads it. Everything Mappify has ever ingested until
// now came from Spotify over TLS or from its own database. This is the first
// input written by a stranger and delivered over Discord, so `decodeExport` is a
// trust boundary in the way `filters.js` is one — it fails closed, drops rather
// than escapes, and never assumes a field is the type it claims to be.
//
// Aggregates, plus — since format 2 — the playlists somebody made and which of
// their tracks are in them. Still no added_at, no listening history, no tokens,
// no Spotify playlist ids: a file is a snapshot, and an id that still resolves
// would make it a pointer at something live that can change or be deleted.
//
// Playlist names are the most personal thing that has ever travelled in one of
// these, which is why the export screen names them before you send it.
//
// Note throughout: `tracks` always means "tracks in the library". Mappify stores
// no listening history, so there is nothing here to call a play count, and a
// field named `plays` in a file that outlives this process would be a lie.

import zlib from 'node:zlib';

import { currentDb } from './context.js';
import { ARTIST_PLACE, ARTIST_IMAGE } from './sql.js';
import { imageMime } from './static.js';

const all = (sql, ...params) => currentDb().prepare(sql).all(...params);
const one = (sql, ...params) => currentDb().prepare(sql).get(...params);
const run = (sql, ...params) => currentDb().prepare(sql).run(...params);

export const MAGIC = 'mappify.share';
/**
 * 2 adds the sources — playlists and Liked Songs — and which tracks are in them.
 *
 * A format 1 file still imports, and lands as a library with no playlists in it;
 * `friends.format` is what the app reads afterwards to tell "shared before
 * playlists travelled" apart from "has none". The other direction cannot be
 * helped: a build that predates this refuses anything that is not exactly 1, so
 * a file from here is unreadable there and says so in those words.
 */
export const FORMAT = 2;
/**
 * The first format whose files carry playlists.
 *
 * Compared against `friends.format` wherever the app has to tell a library that
 * *could not* carry playlists apart from one that had none — never written as a
 * literal 2, which would be the same number meaning two different things.
 */
export const PLAYLIST_FORMAT = 2;
/** Formats this build will open. Anything above FORMAT is a newer Mappify. */
const READABLE = new Set([1, 2]);

/**
 * Columns, declared in the file rather than implied by position alone.
 *
 * Rows travel as arrays because objects would repeat `"spotify_id"` 6,704 times
 * — gzip flattens that, but `JSON.parse` on the far side still allocates every
 * one of those keys. Shipping the header separately keeps the saving and lets a
 * format 2 add a column that a format 1 reader can still map by name.
 */
const PLACE_COLUMNS = ['qid', 'name', 'country_iso', 'lat', 'lon', 'tracks', 'artists'];
const ARTIST_COLUMNS = ['spotify_id', 'name', 'tracks', 'place_qid', 'image_url'];
/**
 * `sources` is the format 2 addition, and is a list of source ids, not a string.
 *
 * Membership rides on the track rather than travelling as its own table of
 * (track, source) pairs, because that table repeats a 22-character track id once
 * per playlist the track is in — on a library where most tracks are in two or
 * three, it is larger than every other table in the file put together. A short
 * array of small integers costs a few bytes on a row that already exists.
 */
const TRACK_COLUMNS = ['spotify_id', 'name', 'artist_id', 'sources'];
/**
 * A playlist, or Liked Songs — `sources.kind` says which.
 *
 * `id` is the exporter's own `sources.id` and means nothing outside the file. It
 * is here only so the track rows above have something short to point at, and it
 * is stored on the friend side under the same rule: a local number, never joined
 * to anything of yours.
 */
const SOURCE_COLUMNS = ['id', 'kind', 'name', 'image_url'];

/**
 * Ceilings, all of them well above any real library.
 *
 * A genuine export is ~1,900 artists and ~6,700 tracks. These are not tuned to
 * that; they are the point past which a file is an attack rather than a
 * collection, and their job is to fail before the insert loop rather than during
 * it.
 */
const LIMITS = {
  artists: 20_000,
  tracks: 200_000,
  places: 5_000,
  /** Spotify's own ceiling on playlists per account is far below this. */
  sources: 2_000,
  /**
   * Memberships one track may claim. A track really can be in dozens of your own
   * playlists; it cannot be in two thousand, and without a cap here a file of
   * 200,000 tracks could claim every source on every one of them and turn one
   * import into 400 million inserts.
   */
  sourcesPerTrack: 64,
  /** Decompressed size. Without this a 1MB file can inflate to gigabytes. */
  inflated: 64 * 1024 * 1024,
  avatarBytes: 256 * 1024,
  name: 200,
};

/**
 * How much of a file may be unreadable before the file itself is.
 *
 * One malformed row should not sink an import — but silently keeping 78% of
 * somebody's library and reporting success is worse than refusing, because the
 * comparison that follows would be wrong in a way nobody could see.
 */
const MAX_DROPPED = 0.2;

/** More than this many friends and the database is the problem, not the feature. */
export const MAX_FRIENDS = 25;

// Every one of these is length-bounded inside the pattern, because the check is
// applied to the raw string. Truncating first and validating after is how
// invalid input becomes valid-looking: `'NOT-ISO'.slice(0, 2)` is `'NO'`, which
// is Norway, and two different 40-character ids clipped to 32 are the same id.
const QID = /^Q\d{1,15}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{16,32}$/;
const ISO = /^[A-Z]{2}$/;

/**
 * The only image host an imported artist picture may point at.
 *
 * `image_url` is a URL chosen by whoever wrote the file, and the importer's
 * browser will fetch it — which hands that person the viewer's IP address and
 * referer on every render. Restricting it to Spotify's own CDN costs one line
 * and removes the whole category.
 */
const SPOTIFY_CDN = /^https:\/\/i\.scdn\.co\/image\/[A-Za-z0-9]{1,200}$/;

/**
 * Where a playlist cover may point — wider, and measured rather than assumed.
 *
 * Of 61 playlists in a real library, three covers were on `i.scdn.co`. The rest
 * were on `mosaic.scdn.co` (25 — the four-album grid Spotify generates for a
 * playlist with no uploaded cover, which is to say for most playlists people
 * actually make) and `image-cdn-ak`/`image-cdn-fa.spotifycdn.com` (22 — a cover
 * somebody uploaded by hand). Reusing the artist rule above would have stripped
 * the cover off 47 of the 50 playlists that had one.
 *
 * Deliberately a second constant rather than a widening of the first: artist
 * portraits really are `i.scdn.co` only, and a boundary widened past what it
 * needs stops being a boundary. Same argument for both — Spotify's own hosts,
 * fetched by the browser exactly as an artist image already is — and a cover
 * matching neither is dropped to null rather than costing the row it is on.
 *
 * The mosaic path is four concatenated ids, hence the wide bound. Still bounded:
 * the pattern is applied to the raw string, never to a clipped one.
 */
const SPOTIFY_COVER =
  /^https:\/\/(?:i\.scdn\.co\/image|mosaic\.scdn\.co\/\d{2,4}|image-cdn-[a-z]{2}\.spotifycdn\.com\/image)\/[A-Za-z0-9]{16,400}$/;

// ---------------------------------------------------------------- export

/**
 * This library, in the shape both the export and the comparison want.
 *
 * One function for both so a file can never describe a different library from
 * the one the app compares against. Place resolution goes through ARTIST_PLACE,
 * the same COALESCE the globe reads, so a pinned artist exports to the city you
 * pinned them to.
 *
 * On that pin: `tools/push-derived.js` says a hand-pinned place never travels,
 * and it is right about its own destination — the shared index, where one
 * person's correction becomes every stranger's silent default. An export is not
 * that. It is a snapshot labelled with your name and your face, landing in
 * `friend_*` tables that no query of the recipient's own library ever reads. So
 * the resolved place travels, but with no provenance: the file records where an
 * artist *is* in this library, never who decided it. Import must never write
 * `artists.origin_override_qid`, and that invariant is what keeps this safe.
 */
export function collectLibrary() {
  const places = all(`
    SELECT s.qid, s.name, s.country_iso, s.lat, s.lon,
           count(DISTINCT ta.track_id)  tracks,
           count(DISTINCT a.spotify_id) artists
    FROM artists a
    JOIN places s ON s.qid = ${ARTIST_PLACE}
    JOIN track_artists ta ON ta.artist_id = a.spotify_id AND ta.position = 0
    WHERE s.lat IS NOT NULL AND s.lon IS NOT NULL
    GROUP BY s.qid
    ORDER BY tracks DESC`);

  const artists = all(`
    SELECT a.spotify_id, a.name,
           count(DISTINCT ta.track_id) tracks,
           ${ARTIST_PLACE} place_qid,
           ${ARTIST_IMAGE} image_url
    FROM artists a
    JOIN track_artists ta ON ta.artist_id = a.spotify_id AND ta.position = 0
    GROUP BY a.spotify_id
    ORDER BY tracks DESC`);

  // Primary artist only, matching how everything else in the app counts. A
  // track appears once, attributed to whoever it is filed under.
  const tracks = all(`
    SELECT t.spotify_id, t.name, ta.artist_id
    FROM tracks t
    JOIN track_artists ta ON ta.track_id = t.spotify_id AND ta.position = 0`);

  // Playlists, and Liked Songs, which is a source like any other here.
  //
  // Two clauses, both load-bearing. `kind IN ('liked','playlist')` leaves out
  // saved albums, which in a real library are 390 of the 452 rows in this table:
  // an album is a catalogue object rather than anything somebody decided, its
  // tracks are already in the file under their artists, and 390 of them would
  // bury the 33 rows that mean something.
  //
  // The join is the second: a playlist you follow but do not own imported with a
  // name and a cover and no tracks, because Spotify will not return its contents
  // to anybody but its owner, and a name with nothing behind it is a row you
  // would open to find nothing. `/api/search` refuses to offer those for the
  // same reason, which is where this predicate comes from.
  const sources = all(`
    SELECT s.id, s.kind, s.name, s.image_url, count(*) tracks
    FROM sources s
    JOIN track_sources ts ON ts.source_id = s.id
    WHERE s.kind IN ('liked', 'playlist')
    GROUP BY s.id
    ORDER BY (s.kind = 'liked') DESC, tracks DESC`);

  const membership = all(`
    SELECT ts.track_id, ts.source_id
    FROM track_sources ts
    JOIN sources s ON s.id = ts.source_id
    WHERE s.kind IN ('liked', 'playlist')`);

  return { places, artists, tracks, sources, membership };
}

/** The comparison's view of this library. See compare.js for the row shapes. */
export function myLibrary() {
  const { places, artists, tracks } = collectLibrary();
  return {
    places,
    artists: artists.map((a) => ({
      id: a.spotify_id,
      name: a.name,
      tracks: a.tracks,
      place_qid: a.place_qid,
      image_url: a.image_url,
    })),
    tracks: tracks.map((t) => ({ id: t.spotify_id })),
  };
}

const pick = (row, columns) => columns.map((c) => row[c] ?? null);

/**
 * The document that becomes a `.mappify` file.
 *
 * `avatar` comes from `fetchAvatarBytes` and is allowed to be null — an export
 * without a face still works, and the card falls back to initials.
 */
export function buildExport({ spotifyId, displayName, avatar = null, appVersion = null }) {
  const { places, artists, tracks, sources, membership } = collectLibrary();

  const placed = new Set(artists.filter((a) => a.place_qid).map((a) => a.spotify_id));
  const placedTracks = tracks.filter((t) => placed.has(t.artist_id)).length;

  // Attached here rather than selected with the tracks: a track is in as many
  // sources as it is in, and a join would return the same track several times
  // for a table whose whole shape says one row each.
  const inSources = new Map();
  for (const m of membership) {
    const list = inSources.get(m.track_id);
    if (list) list.push(m.source_id);
    else inSources.set(m.track_id, [m.source_id]);
  }

  return {
    magic: MAGIC,
    format: FORMAT,
    exported_at: new Date().toISOString(),
    app_version: appVersion,

    user: {
      spotify_id: spotifyId,
      display_name: displayName,
      avatar: avatar ? { mime: avatar.mime, w: avatar.w, h: avatar.h, bytes: avatar.b64 } : null,
    },

    counts: {
      tracks: tracks.length,
      artists: artists.length,
      places: places.length,
      countries: new Set(places.map((p) => p.country_iso).filter(Boolean)).size,
      placed_tracks: placedTracks,
      unplaced_tracks: tracks.length - placedTracks,
      sources: sources.length,
    },

    place_columns: PLACE_COLUMNS,
    places: places.map((p) => pick(p, PLACE_COLUMNS)),
    artist_columns: ARTIST_COLUMNS,
    artists: artists.map((a) => pick(a, ARTIST_COLUMNS)),
    track_columns: TRACK_COLUMNS,
    tracks: tracks.map((t) => pick({ ...t, sources: inSources.get(t.spotify_id) ?? [] }, TRACK_COLUMNS)),
    source_columns: SOURCE_COLUMNS,
    sources: sources.map((s) => pick(s, SOURCE_COLUMNS)),
  };
}

/** The document as the bytes that go down the wire. */
export function encodeExport(payload) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 });
}

/**
 * A filename somebody can find again, and that cannot inject a header.
 *
 * Display names contain quotes, commas, newlines and non-ASCII, all of which
 * mean something in `Content-Disposition`. This is the ASCII fallback; the
 * caller pairs it with a percent-encoded `filename*` for the pretty version.
 */
export function exportFilename(displayName, when = new Date()) {
  const stem =
    String(displayName ?? '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'mappify';
  return `${stem}-${when.toISOString().slice(0, 10)}.mappify`;
}

// ---------------------------------------------------------------- import

/** Refusals a person can act on, told apart from a crash. */
export class BadShareFile extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadShareFile';
  }
}

const text = (v, max = LIMITS.name) => {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, max);
  return s || null;
};

/**
 * A string that matches a pattern exactly, or nothing.
 *
 * Separate from `text` above and never composed with it: `text` clips to a
 * length, and clipping an identifier before checking it is what lets a bad value
 * in wearing a good value's clothes. Every pattern passed here bounds its own
 * length, so there is nothing to clip.
 */
const matching = (v, re) => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return re.test(s) ? s : null;
};

const count = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

const coord = (v, limit) => {
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
};

/** A `[header, rows]` pair back into objects, tolerating a reordered header. */
function rowsToObjects(columns, rows, fallback) {
  const header = Array.isArray(columns) && columns.length ? columns : fallback;
  return (rows ?? []).map((r) => {
    const o = {};
    if (!Array.isArray(r)) return o;
    header.forEach((c, i) => {
      o[c] = r[i];
    });
    return o;
  });
}

/**
 * Bytes from someone else into rows this database is willing to hold.
 *
 * Pure — no database, so it can be tested against a hand-written hostile file.
 * Everything it returns has already been checked; nothing downstream re-validates.
 */
export function decodeExport(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) {
    throw new BadShareFile('That file is empty.');
  }
  // Checked before gunzip so the wrong file gets a sentence rather than a throw
  // from deep inside zlib.
  if (buffer[0] !== 0x1f || buffer[1] !== 0x8b) {
    throw new BadShareFile('That is not a Mappify file.');
  }

  let json;
  try {
    // Without maxOutputLength a crafted megabyte inflates to gigabytes and takes
    // the process with it — which on a hosted instance is every user, not just
    // the one who opened it.
    json = zlib.gunzipSync(buffer, { maxOutputLength: LIMITS.inflated }).toString('utf8');
  } catch {
    throw new BadShareFile('That file is damaged or far too large to be a library.');
  }

  let doc;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new BadShareFile('That file is damaged.');
  }

  if (doc?.magic !== MAGIC) throw new BadShareFile('That is not a Mappify file.');
  if (!READABLE.has(doc.format)) {
    // Only ever a file from ahead of us now: everything behind is in READABLE.
    throw new BadShareFile('That file was made by a newer version of Mappify. Update, then open it again.');
  }

  // Size is checked before anything iterates, so a hostile file costs a length
  // comparison rather than a loop.
  const tooMany = [
    [doc.artists, LIMITS.artists, 'artists'],
    [doc.tracks, LIMITS.tracks, 'tracks'],
    [doc.places, LIMITS.places, 'places'],
    [doc.sources, LIMITS.sources, 'playlists'],
  ].find(([rows, cap]) => Array.isArray(rows) && rows.length > cap);
  if (tooMany) throw new BadShareFile(`That file claims far too many ${tooMany[2]} to be real.`);

  const spotifyId = text(doc.user?.spotify_id, 64);
  if (!spotifyId) throw new BadShareFile('That file does not say who it belongs to.');

  let dropped = 0;
  const keep = (rows, validate) => {
    const out = [];
    for (const r of rows) {
      const v = validate(r);
      if (v) out.push(v);
      else dropped++;
    }
    return out;
  };
  // A ratio per table, not overall: 20% of the places going missing matters even
  // when the artists all survived and swamp the average.
  const refuseIfGutted = (kept, total, what) => {
    if (total && (total - kept.length) / total > MAX_DROPPED) {
      throw new BadShareFile(`That file is corrupt — too many of its ${what} are unreadable.`);
    }
    return kept;
  };

  const rawPlaces = rowsToObjects(doc.place_columns, doc.places, PLACE_COLUMNS);
  const places = refuseIfGutted(
    keep(rawPlaces, (p) => {
      const qid = matching(p.qid, QID);
      const tracks = count(p.tracks);
      if (!qid || tracks == null) return null;
      return {
        qid,
        // As with artists: the qid is the identity and the name is a label.
        name: text(p.name) ?? qid,
        country_iso: matching(p.country_iso, ISO),
        lat: coord(p.lat, 90),
        lon: coord(p.lon, 180),
        tracks,
        artists: count(p.artists) ?? 0,
      };
    }),
    rawPlaces.length,
    'places'
  );

  const rawArtists = rowsToObjects(doc.artist_columns, doc.artists, ARTIST_COLUMNS);
  const artists = refuseIfGutted(
    keep(rawArtists, (a) => {
      const id = matching(a.spotify_id, SPOTIFY_ID);
      const tracks = count(a.tracks);
      if (!id || tracks == null) return null;
      return {
        spotify_id: id,
        // Identity is the Spotify id; the name is a label. Real libraries do
        // contain artists with an empty name — Spotify serves them that way —
        // and dropping one would silently delete every track filed under it from
        // the comparison. Falling back to the id keeps the evidence and makes
        // the gap visible rather than invisible.
        name: text(a.name) ?? id,
        tracks,
        place_qid: matching(a.place_qid, QID),
        image_url: matching(a.image_url, SPOTIFY_CDN),
      };
    }),
    rawArtists.length,
    'artists'
  );

  // Format 1 has no sources at all, and says so by having no rows — not by being
  // an error. Everything below then produces empty lists and the library imports
  // exactly as it did before.
  const rawSources = rowsToObjects(doc.source_columns, doc.sources, SOURCE_COLUMNS);
  // No `refuseIfGutted` here, unlike every table above it. The aggregates *are*
  // the library; a playlist is an annotation on it, and refusing somebody's
  // whole library because a playlist name came through malformed would be the
  // tail wagging the dog. Bad rows are dropped and counted into `dropped`, which
  // the import already reports.
  const sources = keep(rawSources, (s) => {
    const id = count(s.id);
    // Allowlisted rather than taken as read: a kind out of a file is rendered as
    // a category, and a category is copy. `album` is not among them because
    // albums do not travel — see collectLibrary.
    const kind = s.kind === 'liked' || s.kind === 'playlist' ? s.kind : null;
    if (id == null || !kind) return null;
    return {
      id,
      kind,
      // A playlist with an empty name is a real thing people make, and the id is
      // the identity here as everywhere else, so the row survives with a label.
      name: text(s.name) ?? (kind === 'liked' ? 'Liked Songs' : `Playlist ${id}`),
      image_url: matching(s.image_url, SPOTIFY_COVER),
    };
  });
  const sourceIds = new Set(sources.map((s) => s.id));

  const rawTracks = rowsToObjects(doc.track_columns, doc.tracks, TRACK_COLUMNS);
  const tracks = refuseIfGutted(
    keep(rawTracks, (t) => {
      const id = matching(t.spotify_id, SPOTIFY_ID);
      if (!id) return null;
      return {
        spotify_id: id,
        name: text(t.name) ?? '',
        artist_id: matching(t.artist_id, SPOTIFY_ID),
        // Filtered against the sources that actually arrived, so a file naming a
        // playlist it did not send loses that edge and nothing else. Bounded per
        // track as well as per file: see LIMITS.sourcesPerTrack.
        sources: Array.isArray(t.sources)
          ? [...new Set(t.sources.map(count).filter((n) => n != null && sourceIds.has(n)))].slice(
              0,
              LIMITS.sourcesPerTrack
            )
          : [],
      };
    }),
    rawTracks.length,
    'tracks'
  );

  return {
    format: doc.format,
    exported_at: text(doc.exported_at, 40),
    user: {
      spotify_id: spotifyId,
      display_name: text(doc.user?.display_name) ?? spotifyId,
      avatar: decodeAvatar(doc.user?.avatar),
    },
    places,
    artists,
    tracks,
    sources,
    dropped,
  };
}

/**
 * The avatar, or nothing.
 *
 * The nastiest field in the file, because it is the only one that ends up being
 * *served* — an `<img>` on this origin, pointed at bytes a stranger chose. The
 * declared `mime` is ignored entirely in favour of sniffing, and `imageMime`
 * accepts only the three raster formats; SVG is a scriptable document and would
 * turn importing a friend into running their code.
 *
 * A bad avatar is never fatal. Losing a picture is not worth refusing a library.
 */
function decodeAvatar(avatar) {
  if (!avatar || typeof avatar.bytes !== 'string') return null;
  // Bound before decoding: base64 is 4/3 of the bytes, so this refuses to
  // allocate an oversized buffer rather than allocating it and then measuring.
  if (avatar.bytes.length > LIMITS.avatarBytes * 1.4) return null;
  let buf;
  try {
    buf = Buffer.from(avatar.bytes, 'base64');
  } catch {
    return null;
  }
  if (!buf.length || buf.length > LIMITS.avatarBytes) return null;
  const mime = imageMime(buf);
  return mime ? { mime, bytes: buf } : null;
}

// ---------------------------------------------------------------- friends

/**
 * Places this database has since merged, as `qid -> surviving qid`.
 *
 * Both libraries name cities by Wikidata id, so they agree by construction —
 * except when one of them has run places-sync more recently and collapsed a
 * shell into the city it wrapped. The same place then compares as two different
 * qids and the match score drops for a reason that is data freshness rather than
 * taste.
 *
 * Applied once here, at import, rather than at comparison time: doing it later
 * would leave the stored rows disagreeing with every report drawn from them,
 * which is a worse bug than the one being fixed.
 */
function mergeMap() {
  const m = new Map();
  for (const r of all('SELECT qid, merged_into FROM places WHERE merged_into IS NOT NULL')) {
    m.set(r.qid, r.merged_into);
  }
  return m;
}

/** Sum rows that collapsed onto the same surviving qid. */
function remapPlaces(places, merges) {
  const byQid = new Map();
  for (const p of places) {
    const qid = merges.get(p.qid) ?? p.qid;
    const seen = byQid.get(qid);
    if (!seen) {
      byQid.set(qid, { ...p, qid });
      continue;
    }
    seen.tracks += p.tracks;
    // Artist counts are summed rather than unioned: the file carries totals, not
    // the sets behind them, so an artist counted in both halves of a merged pair
    // is counted twice. It is a display figure on somebody else's city and the
    // alternative is shipping their whole artist-to-place mapping.
    seen.artists += p.artists;
    // Coordinates come from whichever row had them — a shell and the city it
    // wrapped sit on top of each other anyway.
    seen.lat ??= p.lat;
    seen.lon ??= p.lon;
  }
  return [...byQid.values()];
}

/**
 * Store a decoded file as a friend, replacing any previous import of the same
 * person.
 *
 * Deliberately does *not* touch `artists`, `tracks`, `places` or `artist_search`.
 * A friend's data is never mixed into your library: it would put rows in your
 * search results that you cannot open, and it would let somebody else's file
 * move dots on your own map. "Why aren't friend artists searchable" has a
 * reasonable-sounding answer and a bad one, and this is the reasonable one.
 */
export function saveFriend(decoded) {
  const db = currentDb();
  const merges = mergeMap();

  const places = remapPlaces(decoded.places, merges);
  const artists = decoded.artists.map((a) => ({
    ...a,
    place_qid: a.place_qid ? merges.get(a.place_qid) ?? a.place_qid : null,
  }));

  const placed = new Set(artists.filter((a) => a.place_qid).map((a) => a.spotify_id));
  const unplacedTracks = decoded.tracks.filter((t) => !placed.has(t.artist_id)).length;

  // Counts are derived from what actually survived validation, never read from
  // the file's own `counts` block — that block is a claim by the sender, and the
  // header saying 6,704 while 40 rows arrived is exactly the case worth catching.
  db.exec('BEGIN');
  try {
    const existing = one('SELECT id FROM friends WHERE spotify_id = ?', decoded.user.spotify_id);
    if (!existing) {
      const n = one('SELECT count(*) n FROM friends').n;
      if (n >= MAX_FRIENDS) {
        throw new BadShareFile(
          `You already have ${MAX_FRIENDS} imported libraries. Remove one to add another.`
        );
      }
    } else {
      // Replace rather than merge: a re-import is a newer snapshot of the same
      // person, and half of an old library left behind would be invisible.
      for (const t of [
        'friend_places',
        'friend_artists',
        'friend_tracks',
        'friend_sources',
        'friend_track_sources',
      ]) {
        run(`DELETE FROM ${t} WHERE friend_id = ?`, existing.id);
      }
      run('DELETE FROM friends WHERE id = ?', existing.id);
    }

    run(
      `INSERT INTO friends
         (spotify_id, display_name, avatar_mime, avatar_blob, format, exported_at,
          imported_at, tracks, artists, places, unplaced_tracks, skipped_rows)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      decoded.user.spotify_id,
      decoded.user.display_name,
      decoded.user.avatar?.mime ?? null,
      decoded.user.avatar?.bytes ?? null,
      decoded.format,
      decoded.exported_at,
      new Date().toISOString(),
      decoded.tracks.length,
      artists.length,
      places.length,
      unplacedTracks,
      decoded.dropped
    );
    const id = one('SELECT id FROM friends WHERE spotify_id = ?', decoded.user.spotify_id).id;

    const insPlace = db.prepare(
      `INSERT INTO friend_places (friend_id, qid, name, country_iso, lat, lon, tracks, artists)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    for (const p of places) {
      insPlace.run(id, p.qid, p.name, p.country_iso, p.lat, p.lon, p.tracks, p.artists);
    }

    const insArtist = db.prepare(
      `INSERT OR IGNORE INTO friend_artists
         (friend_id, spotify_id, name, tracks, place_qid, image_url) VALUES (?,?,?,?,?,?)`
    );
    for (const a of artists) {
      insArtist.run(id, a.spotify_id, a.name, a.tracks, a.place_qid, a.image_url);
    }

    const insTrack = db.prepare(
      `INSERT OR IGNORE INTO friend_tracks (friend_id, spotify_id, name, artist_id)
       VALUES (?,?,?,?)`
    );
    for (const t of decoded.tracks) insTrack.run(id, t.spotify_id, t.name, t.artist_id);

    // Membership comes off the track rows, so it can only ever name tracks that
    // survived validation — there is no second list to fall out of step with the
    // first. Counted while inserting, because a source's size is a fact about
    // what arrived and not a number the file gets to assert; see the note on
    // `counts` above.
    const held = new Map((decoded.sources ?? []).map((s) => [s.id, 0]));
    const insMember = db.prepare(
      `INSERT OR IGNORE INTO friend_track_sources (friend_id, source_id, track_id) VALUES (?,?,?)`
    );
    for (const t of decoded.tracks) {
      for (const sid of t.sources ?? []) {
        if (!held.has(sid)) continue;
        insMember.run(id, sid, t.spotify_id);
        held.set(sid, held.get(sid) + 1);
      }
    }

    const insSource = db.prepare(
      `INSERT OR IGNORE INTO friend_sources
         (friend_id, source_id, kind, name, image_url, tracks) VALUES (?,?,?,?,?,?)`
    );
    // A playlist every one of whose tracks was dropped is not a playlist worth
    // listing: it would open onto nothing, which is the same rule that kept
    // their un-owned playlists out of the file in the first place.
    let playlists = 0;
    for (const s of decoded.sources ?? []) {
      if (!held.get(s.id)) continue;
      insSource.run(id, s.id, s.kind, s.name, s.image_url, held.get(s.id));
      playlists++;
    }
    // Written after the loop rather than guessed before it, for the same reason
    // every other count here is derived: this is how many arrived.
    run('UPDATE friends SET playlists = ? WHERE id = ?', playlists, id);

    db.exec('COMMIT');
    return getFriend(id);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Everyone imported. Never carries the avatar bytes — see `friendAvatar`. */
export function listFriends() {
  return all(`
    SELECT id, spotify_id, display_name, format, exported_at, imported_at,
           tracks, artists, places, playlists, unplaced_tracks, skipped_rows,
           avatar_blob IS NOT NULL AS has_avatar
    FROM friends
    ORDER BY imported_at DESC`);
}

export function getFriend(id) {
  return one(
    `SELECT id, spotify_id, display_name, format, exported_at, imported_at,
            tracks, artists, places, playlists, unplaced_tracks, skipped_rows,
            avatar_blob IS NOT NULL AS has_avatar
     FROM friends WHERE id = ?`,
    id
  );
}

export function friendAvatar(id) {
  return one('SELECT avatar_mime mime, avatar_blob bytes FROM friends WHERE id = ?', id);
}

/** One statement, because ON DELETE CASCADE carries every child table. */
export function deleteFriend(id) {
  run('DELETE FROM friends WHERE id = ?', id);
}

/**
 * A friend's places, in the shape the globe already draws.
 *
 * Read entirely out of `friend_places` and never joined to `places`. A friend is
 * from cities you have no artist from — that is the interesting half of the
 * comparison — and those are precisely the rows your own table does not have, so
 * a join would drop them or, worse, leave them at a null coordinate.
 */
export function friendPoints(id) {
  return all(
    `SELECT qid, name, country_iso, lat, lon, tracks, artists
     FROM friend_places
     WHERE friend_id = ? AND lat IS NOT NULL AND lon IS NOT NULL
     ORDER BY tracks DESC`,
    id
  );
}

/** The comparison's view of a friend. Mirrors `myLibrary`. */
export function friendLibrary(id) {
  return {
    places: all(
      `SELECT qid, name, country_iso, lat, lon, tracks, artists
       FROM friend_places WHERE friend_id = ?`,
      id
    ),
    artists: all(
      `SELECT spotify_id id, name, tracks, place_qid, image_url
       FROM friend_artists WHERE friend_id = ?`,
      id
    ),
    tracks: all('SELECT spotify_id id FROM friend_tracks WHERE friend_id = ?', id),
  };
}
