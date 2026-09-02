// Schema + connection. node:sqlite is built in on Node 22.5+ (unflagged on 24),
// so the database and the search index cost zero dependencies.

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ARTIST_PLACE_NAME } from './sql.js';

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
export const DB_PATH = process.env.MAPPIFY_DB ?? path.join(ROOT, 'mappify.db');

// One database file per user, rather than a user_id column on shared tables.
//
// With shared tables, a single forgotten `WHERE user_id = ?` leaks somebody
// else's listening history, and the query that forgets it looks exactly like the
// forty that do not. openUserDb(id) cannot leak by omission: there is nothing in
// the file to leak. The MusicBrainz index stays global and shared — it holds
// facts about artists, not about people.

/**
 * Where the databases live, resolved in this order:
 *
 *   1. MAPPIFY_DATA, for anyone who wants to say
 *   2. an existing `data/` beside the app — a checkout, or an install that
 *      predates this. Never stranded: someone's library does not move because
 *      they updated
 *   3. the per-user application data directory
 *
 * Three exists because an installed application cannot write next to its own
 * executable: Program Files is read-only for anything but an installer, so the
 * old default failed the moment this stopped being a folder you unzipped.
 *
 * `index.db` deliberately does not live here. It is opened read-only and never
 * written, so it stays beside the app where the installer put it.
 */
function defaultDataDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? os.homedir(), 'Mappify');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Mappify');
  }
  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'),
    'mappify'
  );
}

const LEGACY_DATA = path.join(ROOT, 'data');

export const DATA_DIR =
  process.env.MAPPIFY_DATA ??
  (fs.existsSync(path.join(LEGACY_DATA, 'control.db')) ? LEGACY_DATA : defaultDataDir());

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 8000;   -- the enrichment pass may hold the write lock

CREATE TABLE IF NOT EXISTS artists (
  spotify_id        TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  mbid              TEXT,
  artist_type       TEXT,              -- Group | Person. Changes what begin-area means.
  status            TEXT,              -- ok | no-mb-match | no-area | error
  source            TEXT,              -- musicbrainz | musicbrainz-fuzzy | wikidata
  fuzzy             INTEGER DEFAULT 0, -- matched by name, not by Spotify URL. Distrust.

  -- MusicBrainz. area.name is NOT reliably a country: it holds Memphis, Hackney,
  -- Scotland for some artists. mb_country_iso is the trustworthy country signal.
  mb_city           TEXT,
  mb_country        TEXT,
  mb_country_iso    TEXT,
  mb_begin_area_id  TEXT,              -- area MBID -> Wikidata P982 -> P625 coords
  mb_area_id        TEXT,

  -- Wikidata. Kept separate forever; the two sources genuinely disagree.
  wd_city           TEXT,
  wd_country        TEXT,
  wd_qid            TEXT,

  place_qid         TEXT REFERENCES places(qid),
  mb_resolved_at    TEXT,              -- set only once an artist is settled
  wd_resolved_at    TEXT,
  origin_resolved_at TEXT,
  error             TEXT
);

-- MusicBrainz area -> Wikidata place is many-to-many in practice: several areas
-- can point at one place, and one area can be claimed by more than one item.
-- Keeping the mapping here instead of as a UNIQUE column on places is what stops
-- a whole batch from dying on a constraint violation.
CREATE TABLE IF NOT EXISTS place_areas (
  mb_area_id  TEXT PRIMARY KEY,
  qid         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_place_areas_qid ON place_areas(qid);

CREATE TABLE IF NOT EXISTS places (
  qid            TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  country        TEXT,
  country_iso    TEXT,
  lat            REAL,
  lon            REAL,
  -- P131, but only kept when the parent is itself a human settlement. Brooklyn's
  -- parent is New York City (kept); Atlanta's are Fulton and DeKalb County (dropped),
  -- so Atlanta stays top-level instead of nesting under a county.
  parent_qid     TEXT,
  resolved_at    TEXT
);

-- The containment skeleton: every node on a P131 chain above a place, including
-- the counties, states and regions that are deliberately not places.
--
-- Separate from places because everything that draws the app reads that table --
-- the browse tree, the globe, the place picker. Materialising 520 counties there
-- put Bologna under "Metropolitan City of Bologna" and offered Texas as a place
-- to pin an artist to. This table answers one question, "what contains what",
-- and nothing renders it.
CREATE TABLE IF NOT EXISTS admin_areas (
  qid              TEXT PRIMARY KEY,
  name             TEXT,
  admin_parent_qid TEXT,
  -- P36, the seat. Carried because "Musicians from Los Angeles" is ambiguous
  -- between the city and the county it administers, and that ambiguity is what
  -- would otherwise drag Snoop Dogg out of Long Beach.
  capital_qid      TEXT,
  resolved_at      TEXT
);

CREATE TABLE IF NOT EXISTS tracks (
  spotify_id   TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  album        TEXT,
  uri          TEXT,
  url          TEXT,
  duration_ms  INTEGER
);

CREATE TABLE IF NOT EXISTS track_artists (
  track_id   TEXT NOT NULL REFERENCES tracks(spotify_id) ON DELETE CASCADE,
  artist_id  TEXT NOT NULL REFERENCES artists(spotify_id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,        -- 0 = primary
  PRIMARY KEY (track_id, artist_id)
);

CREATE TABLE IF NOT EXISTS sources (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,      -- liked | playlist
  spotify_id      TEXT UNIQUE,        -- null for the Liked Songs pseudo-source
  name            TEXT NOT NULL,
  owner_id        TEXT,
  snapshot_id     TEXT,               -- unchanged snapshot => skip re-reading
  track_total     INTEGER,
  last_synced_at  TEXT
);

CREATE TABLE IF NOT EXISTS track_sources (
  track_id   TEXT NOT NULL REFERENCES tracks(spotify_id) ON DELETE CASCADE,
  source_id  INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  added_at   TEXT,
  PRIMARY KEY (track_id, source_id)
);

CREATE TABLE IF NOT EXISTS auth (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  client_id      TEXT,
  access_token   TEXT,
  refresh_token  TEXT,
  expires_at     INTEGER,
  scope          TEXT
);

CREATE INDEX IF NOT EXISTS idx_artists_city    ON artists(mb_city);
CREATE INDEX IF NOT EXISTS idx_artists_iso     ON artists(mb_country_iso);
CREATE INDEX IF NOT EXISTS idx_artists_mbid    ON artists(mbid);
CREATE INDEX IF NOT EXISTS idx_ta_artist       ON track_artists(artist_id);
CREATE INDEX IF NOT EXISTS idx_ts_source       ON track_sources(source_id);

-- A friend is a file somebody sent you: not an account, not a connection, and
-- not verified in any way. Their library lives in your database because every
-- read on this server goes through currentDb() — a second file would be
-- unreachable from a handler, and a shared one would reintroduce the exact
-- "forgot the WHERE user_id" hazard that one-database-per-user exists to make
-- impossible.
--
-- Kept rigorously apart from artists/tracks/places. Nothing here is ever mixed
-- into your own library or into the search index: it would put rows in your
-- results that you cannot open, and let somebody else's file move dots on your
-- map. See server/share.js.
CREATE TABLE IF NOT EXISTS friends (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Re-importing the same person replaces them rather than duplicating them.
  spotify_id       TEXT NOT NULL UNIQUE,
  display_name     TEXT NOT NULL,
  avatar_mime      TEXT,
  -- The bytes themselves; base64 is how they travel, not how they are kept.
  avatar_blob      BLOB,
  format           INTEGER NOT NULL,
  exported_at      TEXT,
  imported_at      TEXT NOT NULL,
  tracks           INTEGER NOT NULL DEFAULT 0,
  artists          INTEGER NOT NULL DEFAULT 0,
  places           INTEGER NOT NULL DEFAULT 0,
  unplaced_tracks  INTEGER,
  -- Rows validation dropped, kept so the import can say so rather than quietly
  -- reporting a library smaller than the one that was sent.
  skipped_rows     INTEGER NOT NULL DEFAULT 0
);

-- Deliberately no REFERENCES places(qid), and lat/lon are columns rather than a
-- join. A friend is from cities you have never heard of, and those are the
-- interesting ones — reading coordinates from your own places table is how a
-- friend's globe silently collapses to null island.
--
-- WITHOUT ROWID throughout: every comparison query is either "all rows for
-- friend N" or "does friend N have X", so the composite key is the access path
-- and the row may as well *be* the index.
CREATE TABLE IF NOT EXISTS friend_places (
  friend_id    INTEGER NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  qid          TEXT NOT NULL,
  name         TEXT NOT NULL,
  country_iso  TEXT,
  lat          REAL,
  lon          REAL,
  tracks       INTEGER NOT NULL,
  artists      INTEGER NOT NULL,
  PRIMARY KEY (friend_id, qid)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS friend_artists (
  friend_id   INTEGER NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  spotify_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  tracks      INTEGER NOT NULL,
  place_qid   TEXT,
  image_url   TEXT,
  PRIMARY KEY (friend_id, spotify_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS friend_tracks (
  friend_id   INTEGER NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  spotify_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  artist_id   TEXT,
  PRIMARY KEY (friend_id, spotify_id)
) WITHOUT ROWID;

-- Their playlists, and Liked Songs, which is a source like any other. Only files
-- of format 2 and up carry these; a library imported from an older file simply
-- has no rows here, and friends.format is what tells that apart from a library
-- that genuinely has none.
--
-- source_id is the number the *file* used and is meaningless outside it. It is
-- never joined to sources: yours and theirs are two unrelated sequences, and a
-- join between them would silently pair your playlist 4 with their playlist 4.
CREATE TABLE IF NOT EXISTS friend_sources (
  friend_id   INTEGER NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  source_id   INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  image_url   TEXT,
  tracks      INTEGER NOT NULL,
  PRIMARY KEY (friend_id, source_id)
) WITHOUT ROWID;

-- Key order is the question: "every track in this playlist" is then one range
-- scan, which is the only way this table is ever read.
CREATE TABLE IF NOT EXISTS friend_track_sources (
  friend_id   INTEGER NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  source_id   INTEGER NOT NULL,
  track_id    TEXT NOT NULL,
  PRIMARY KEY (friend_id, source_id, track_id)
) WITHOUT ROWID;

-- The reverse direction the primary keys cannot serve: "which of my friends has
-- this artist", which the artist panel wants the moment this ships.
CREATE INDEX IF NOT EXISTS idx_fa_artist ON friend_artists(spotify_id);
CREATE INDEX IF NOT EXISTS idx_ft_artist ON friend_tracks(friend_id, artist_id);

`;

// Artist-first search: results are artists, so the index is over artists.
//
// Kept out of SCHEMA because it is the one statement that can fail on a working
// Node. `node:sqlite` only gained FTS5 in Node 24 — on 22 this throws "no such
// module: fts5", and inside SCHEMA that took the whole database down with it, so
// signing in on a runtime without FTS5 failed at the point of creating the user's
// file. Search falls back to LIKE, which is slower and perfectly usable at the
// scale of one person's library.
//
// `place` rather than `city`: the column holds the name of the place the artist
// actually resolves to, which is not the same string as the city MusicBrainz
// reported. An artist you have pinned to Detroit was findable only by the
// birthplace you corrected them away from for as long as this indexed the raw
// value — the index has to answer the question the map answers.
const SEARCH_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS artist_search USING fts5(
  spotify_id UNINDEXED, name, place, country, tokenize = 'unicode61'
);
`;

let ftsAvailable;

/**
 * Creates the search index for this database, and reports whether it exists.
 *
 * The capability belongs to the runtime, so a "no" is remembered and never
 * retried; the table itself still has to be created per database, which is why
 * this runs the statement rather than only answering from the cache.
 */
export function hasFts(db) {
  // An escape hatch, because otherwise the LIKE path is unreachable on a
  // runtime that has FTS5 — and that path is what every Node 22 install uses.
  // Untested code that only strangers run is how it rots.
  if (process.env.MAPPIFY_NO_FTS === '1') return false;
  if (ftsAvailable === undefined) {
    // Probed against a throwaway table in `temp`, not by trying to create the
    // real one: `CREATE VIRTUAL TABLE IF NOT EXISTS` short-circuits when the
    // table is already in the file, so on a database written by Node 24 and
    // opened on Node 22 it reports success without ever loading the module — and
    // search then failed at query time, which is the worst place to find out.
    try {
      db.exec('CREATE VIRTUAL TABLE temp.fts_probe USING fts5(x)');
      db.exec('DROP TABLE temp.fts_probe');
      ftsAvailable = true;
    } catch {
      ftsAvailable = false;
    }
  }
  if (!ftsAvailable) return false;
  db.exec(SEARCH_SCHEMA);
  return true;
}

// Columns added after a database already exists. CREATE TABLE IF NOT EXISTS will
// not add them, so they are applied explicitly and idempotently.
const ADDED_COLUMNS = [
  ['places', 'parent_qid', 'TEXT'],
  ['places', 'resolved_at', 'TEXT'],
  ['places', 'is_city', 'INTEGER'],
  ['places', 'capital_qid', 'TEXT'],
  // The *unfiltered* P131 parent, counties and states included, purely so
  // "is A inside B" is computable. Deliberately a second column rather than a
  // widening of parent_qid: that one only accepts settlements, which is what
  // stops Atlanta nesting under Fulton County in the browse tree. Nothing that
  // draws the tree, the map or the links may read this one.
  //
  // is_city cannot substitute for it — Braintree and Brooklyn are both
  // is_city = 0, so any rule built on that would also refuse Staten Island.
  ['places', 'admin_parent_qid', 'TEXT'],
  ['admin_areas', 'capital_qid', 'TEXT'],
  // Set on administrative shells that wrap a single real city (Metropolitan City
  // of Milan around Milan). The row is kept; only display resolves through this.
  ['places', 'merged_into', 'TEXT'],
  // Replaces genres_resolved_at now that genres are gone; still the stamp that
  // says an artist's MusicBrainz areas have been fetched.
  ['artists', 'origin_resolved_at', 'TEXT'],
  ['artists', 'image_url', 'TEXT'],
  // A place you set by hand, which beats anything the data says.
  //
  // MusicBrainz's begin_area is a birthplace for a person, and nothing available
  // means "where they started making music": Wikidata's work location covers 5%
  // of the people in a library, residence 10% and ambiguously — 2Pac lists seven
  // — and Kanye West, born in Atlanta and made in Chicago, has neither. The data
  // to fix that does not exist, so the correction has to be yours.
  ['artists', 'origin_override_qid', 'TEXT'],
  // The "origin" field from an artist's Wikipedia infobox — "where the act is
  // from", which is what a birthplace fails to say. Kept apart from the manual
  // pin above so the two never get confused for one another: yours always wins,
  // and a row can honestly say which of the two put it where it is.
  ['artists', 'origin_wiki_qid', 'TEXT'],
  ['tracks', 'image_url', 'TEXT'],
  ['sources', 'image_url', 'TEXT'],
  ['sources', 'owned', 'INTEGER'],
  ['sources', 'note', 'TEXT'],
  // How many playlists an imported library brought. Nullable on purpose, like
  // unplaced_tracks: a library imported before this column existed did not
  // carry any and did not fail to — `friends.format` is what says which.
  ['friends', 'playlists', 'INTEGER'],
];

export function openDb(file = DB_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);

  // places used to carry a UNIQUE mb_area_id, which cannot represent the real
  // many-to-many mapping. It is fully derived data, so the old shape is dropped
  // and rebuilt by `node server/places.js` rather than migrated in place.
  const legacy = db
    .prepare(`SELECT count(*) n FROM pragma_table_info('places') WHERE name = 'mb_area_id'`)
    .get().n;
  if (legacy) db.exec('DROP TABLE places');

  // The genre feature is gone: its associations were too loose to trust. Dropping
  // the tables here rather than leaving them dormant, because CREATE TABLE IF NOT
  // EXISTS would otherwise keep them alive in every database that already has them.
  db.exec(`DROP TABLE IF EXISTS artist_genres;
           DROP TABLE IF EXISTS genre_edges;
           DROP TABLE IF EXISTS genres;`);

  // fts5 tables cannot be ALTERed, so a column-set change means recreating it.
  // reindexSearch() below refills it from the artists table.
  //
  // In a try, because reading an fts5 table's columns needs the fts5 module, and
  // a database written by Node 24 opened on Node 22 has the table but not the
  // module. Unguarded, this threw inside openDb and took every route with it —
  // the library would not even load, let alone search. Nothing to migrate on
  // such a runtime anyway: it cannot have written the old shape either.
  //
  // Two column-set changes now: `genres`, dropped with the feature, and `city`,
  // which became `place` when the index started reading through to the resolved
  // place instead of the raw MusicBrainz string. Either one means recreate.
  let ftsStale = 0;
  try {
    ftsStale = db
      .prepare(
        `SELECT count(*) n FROM pragma_table_info('artist_search')
          WHERE name IN ('genres', 'city')`
      )
      .get().n;
    if (ftsStale) db.exec('DROP TABLE artist_search');
  } catch {
    ftsStale = 0;
  }

  db.exec(SCHEMA);

  for (const [table, column, type] of ADDED_COLUMNS) {
    const has = db
      .prepare(`SELECT count(*) n FROM pragma_table_info(?) WHERE name = ?`)
      .get(table, column).n;
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  // Carry the old stamp across, or every already-enriched artist would look
  // unresolved and the next run would re-fetch all of them.
  const hadGenreStamp = db
    .prepare(`SELECT count(*) n FROM pragma_table_info('artists') WHERE name = 'genres_resolved_at'`)
    .get().n;
  if (hadGenreStamp) {
    db.exec(`UPDATE artists SET origin_resolved_at = genres_resolved_at
             WHERE origin_resolved_at IS NULL AND genres_resolved_at IS NOT NULL`);
  }

  // After the columns exist, so a rebuild below has rows to read. A runtime
  // without FTS5 simply gets no index and searches with LIKE instead.
  const fts = hasFts(db);

  if (fts && ftsStale) reindexSearch(db);
  return db;
}

/**
 * A Spotify user id, reduced to something that cannot escape DATA_DIR.
 *
 * Spotify ids are alphanumeric in practice, but this value arrives from an HTTP
 * response and ends up in a filename, which is the classic way a "../" reaches
 * the filesystem. Anything outside the safe set is rejected rather than
 * rewritten, so two different ids can never collapse onto one file.
 */
function safeUserId(userId) {
  if (typeof userId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(userId)) {
    throw new Error(`Refusing to use ${JSON.stringify(userId)} as a database name`);
  }
  return userId;
}

export const userDbPath = (userId) => path.join(DATA_DIR, `u_${safeUserId(userId)}.db`);

// Opening a database is cheap but not free, and a handle per request would also
// mean a fresh schema check per request. Keyed by path, so the same user reuses
// one handle and two users never share one.
const handles = new Map();

export function openUserDb(userId) {
  const file = userDbPath(userId);
  if (!handles.has(file)) handles.set(file, openDb(file));
  return handles.get(file);
}

export function listUsers() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.startsWith('u_') && f.endsWith('.db'))
    .map((f) => f.slice(2, -3));
}

/**
 * The database a command-line tool should work on.
 *
 * Tools predate multi-tenancy and take no user. Rather than guess, this resolves
 * in order and says what it did: an explicit MAPPIFY_DB, then `--user <id>`,
 * then the single user database if there is exactly one, then the legacy
 * single-tenant file. With several users and no flag it refuses and lists them,
 * because picking one for you is how a correction lands in the wrong library.
 */
export function openDbForCli(argv = process.argv.slice(2)) {
  if (process.env.MAPPIFY_DB) return openDb(process.env.MAPPIFY_DB);

  const i = argv.indexOf('--user');
  if (i >= 0 && argv[i + 1]) return openUserDb(argv[i + 1]);

  const users = listUsers();
  if (users.length === 1) return openUserDb(users[0]);
  if (users.length > 1) {
    throw new Error(
      `${users.length} users on this instance — say which:\n` +
        users.map((u) => `  --user ${u}`).join('\n')
    );
  }
  return openDb();
}

/**
 * The instance-wide database: who has signed in, and their live sessions.
 *
 * Deliberately not a table inside anyone's library. A session lookup happens
 * before we know whose library to open, so it cannot live in the file it would
 * be used to choose.
 */
let controlDb;
export function openControlDb() {
  if (controlDb) return controlDb;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(DATA_DIR, 'control.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 8000;

    CREATE TABLE IF NOT EXISTS users (
      spotify_id    TEXT PRIMARY KEY,
      display_name  TEXT,
      created_at    TEXT,
      last_seen_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,   -- random, and the only thing the cookie holds
      user_id     TEXT NOT NULL,
      created_at  TEXT,
      expires_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    -- One row per authorization in flight, holding the PKCE verifier. Short
    -- lived by design: a row that never gets claimed is a flow someone
    -- abandoned, and is swept on the next sign-in.
    CREATE TABLE IF NOT EXISTS pending_auth (
      state       TEXT PRIMARY KEY,
      verifier    TEXT NOT NULL,
      created_at  INTEGER
    );

    -- Instance settings that would otherwise mean editing a file. The Spotify
    -- client id is the only one so far, and it is here because "open .env in a
    -- text editor" is where someone running this on their own laptop gives up.
    -- The environment wins on a hosted instance, so a server deployment keeps
    -- configuring it the usual way; on loopback a value entered on the setup
    -- screen wins instead, being the more recent decision of the one person who
    -- can reach it. See clientId() in server/auth.js.
    CREATE TABLE IF NOT EXISTS settings (
      key    TEXT PRIMARY KEY,
      value  TEXT
    );
  `);
  controlDb = db;
  return db;
}

/**
 * What one artist looks like to the index.
 *
 * The resolved place first — the same COALESCE the map reads, so the index and
 * the dots agree about a pinned artist — with the raw city kept as the tail, so
 * somebody who has no resolved place yet is still findable by the city shown on
 * their row rather than by nothing at all.
 */
const SEARCH_ROW = `
  SELECT a.spotify_id, a.name,
         COALESCE(${ARTIST_PLACE_NAME}, a.mb_city, a.wd_city, ''),
         COALESCE(a.mb_country, a.wd_country, '')
    FROM artists a`;

/** Rebuilds the FTS index from current rows. Cheap enough to just redo wholesale. */
export function reindexSearch(db) {
  if (!hasFts(db)) return;
  db.exec('DELETE FROM artist_search');
  db.exec(`INSERT INTO artist_search (spotify_id, name, place, country) ${SEARCH_ROW}`);
}

/**
 * The same, for one artist.
 *
 * Pinning an origin changes where exactly one person is from, and rebuilding
 * the whole index for that is work proportional to the library rather than to
 * the edit. Without it the index simply stays wrong until the next import.
 */
export function reindexArtist(db, spotifyId) {
  if (!hasFts(db)) return;
  db.prepare('DELETE FROM artist_search WHERE spotify_id = ?').run(spotifyId);
  db.prepare(
    `INSERT INTO artist_search (spotify_id, name, place, country)
     ${SEARCH_ROW} WHERE a.spotify_id = ?`
  ).run(spotifyId);
}

if (import.meta.filename === process.argv[1]) {
  const db = openDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")
    .all()
    .map((r) => r.name);
  console.log(`Initialised ${DB_PATH}`);
  console.log(tables.join(', '));
  db.close();
}
