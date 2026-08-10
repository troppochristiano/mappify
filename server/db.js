// Schema + connection. node:sqlite is built in on Node 22.5+ (unflagged on 24),
// so the database and the search index cost zero dependencies.

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
export const DB_PATH = process.env.MAPPIFY_DB ?? path.join(ROOT, 'mappify.db');

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

-- Artist-first search: results are artists, so the index is over artists.
CREATE VIRTUAL TABLE IF NOT EXISTS artist_search USING fts5(
  spotify_id UNINDEXED, name, city, country, tokenize = 'unicode61'
);
`;

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
  const ftsHasGenres = db
    .prepare(`SELECT count(*) n FROM pragma_table_info('artist_search') WHERE name = 'genres'`)
    .get().n;
  if (ftsHasGenres) db.exec('DROP TABLE artist_search');

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

  if (ftsHasGenres) reindexSearch(db);
  return db;
}

/** Rebuilds the FTS index from current rows. Cheap enough to just redo wholesale. */
export function reindexSearch(db) {
  db.exec('DELETE FROM artist_search');
  db.exec(`
    INSERT INTO artist_search (spotify_id, name, city, country)
    SELECT a.spotify_id, a.name,
           COALESCE(a.mb_city, a.wd_city, ''),
           COALESCE(a.mb_country, a.wd_country, '')
    FROM artists a
  `);
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
