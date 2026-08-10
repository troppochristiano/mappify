// One-shot import of liked-origins/.cache into mappify.db.
// Strictly offline: 665 artists cost ~22 minutes of rate-limited MusicBrainz time
// and must never be re-fetched just to change storage engine.
//
//   node server/migrate-cache.js [pathToLikedOriginsCache]

import fs from 'node:fs';
import path from 'node:path';
import { openDb, reindexSearch, ROOT } from './db.js';

const cacheDir =
  process.argv[2] ?? path.resolve(ROOT, '..', 'liked-origins', '.cache');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${err.message}`);
  }
}

const artistsJson = readJson(path.join(cacheDir, 'artists.json'));
const tracksJson = readJson(path.join(cacheDir, 'tracks.json'));
const cachedTracks = tracksJson.tracks ?? [];

const db = openDb();

const upsertArtist = db.prepare(`
  INSERT INTO artists (spotify_id, name, mbid, artist_type, status, source, fuzzy,
                       mb_city, mb_country, mb_country_iso,
                       wd_city, wd_country, wd_qid,
                       mb_resolved_at, wd_resolved_at, error)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(spotify_id) DO UPDATE SET
    name = excluded.name, mbid = excluded.mbid, artist_type = excluded.artist_type,
    status = excluded.status, source = excluded.source, fuzzy = excluded.fuzzy,
    mb_city = excluded.mb_city, mb_country = excluded.mb_country,
    mb_country_iso = excluded.mb_country_iso,
    wd_city = excluded.wd_city, wd_country = excluded.wd_country, wd_qid = excluded.wd_qid,
    mb_resolved_at = excluded.mb_resolved_at, wd_resolved_at = excluded.wd_resolved_at,
    error = excluded.error
`);

const upsertTrack = db.prepare(`
  INSERT INTO tracks (spotify_id, name, album, uri, url)
  VALUES (?,?,?,?,?)
  ON CONFLICT(spotify_id) DO UPDATE SET
    name = excluded.name, album = excluded.album, uri = excluded.uri, url = excluded.url
`);

const linkArtist = db.prepare(
  'INSERT OR REPLACE INTO track_artists (track_id, artist_id, position) VALUES (?,?,?)'
);
const linkSource = db.prepare(
  'INSERT OR REPLACE INTO track_sources (track_id, source_id, added_at) VALUES (?,?,?)'
);

db.exec('BEGIN');
try {
  db.prepare(
    `INSERT INTO sources (kind, spotify_id, name, last_synced_at)
     VALUES ('liked', NULL, 'Liked Songs', ?)
     ON CONFLICT(spotify_id) DO NOTHING`
  ).run(tracksJson.fetchedAt ?? null);

  const likedId = db
    .prepare("SELECT id FROM sources WHERE kind = 'liked'")
    .get().id;

  let artistCount = 0;
  for (const e of Object.values(artistsJson)) {
    if (!e?.spotifyId) continue;
    upsertArtist.run(
      e.spotifyId,
      e.name ?? '',
      e.mbid ?? null,
      e.artistType ?? null,
      e.status ?? null,
      e.source ?? null,
      e.fuzzy ? 1 : 0,
      e.city ?? null,
      e.country ?? null,
      e.countryCode ?? null,
      e.wikidataCity ?? null,
      e.wikidataCountry ?? null,
      e.qid ?? null,
      e.mbLookupAt ?? null,
      e.wikidataAt ?? null,
      e.error ?? null
    );
    artistCount++;
  }

  // Artists credited on tracks but absent from the cache (the CLI only resolved
  // primary artists) still need rows, or track_artists would violate its FK.
  const stubArtist = db.prepare(
    'INSERT INTO artists (spotify_id, name) VALUES (?,?) ON CONFLICT(spotify_id) DO NOTHING'
  );

  let trackCount = 0;
  let linkCount = 0;
  for (const t of cachedTracks) {
    upsertTrack.run(t.id, t.name, t.album ?? null, t.uri ?? null, t.url ?? null);
    linkSource.run(t.id, likedId, t.added_at ?? null);
    trackCount++;
    (t.artists ?? []).forEach((a, i) => {
      if (!a?.id) return;
      stubArtist.run(a.id, a.name ?? '');
      linkArtist.run(t.id, a.id, i);
      linkCount++;
    });
  }

  db.prepare('UPDATE sources SET track_total = ? WHERE id = ?').run(trackCount, likedId);
  db.exec('COMMIT');

  reindexSearch(db);

  const q = (sql) => db.prepare(sql).get();
  const resolved = q(
    "SELECT count(*) n FROM artists WHERE mb_resolved_at IS NOT NULL OR status IS NOT NULL"
  ).n;
  const primaries = q(`
    SELECT count(*) total,
           sum(CASE WHEN COALESCE(a.mb_city, a.wd_city) IS NOT NULL THEN 1 ELSE 0 END) city,
           sum(CASE WHEN COALESCE(a.mb_country, a.wd_country) IS NOT NULL THEN 1 ELSE 0 END) country
    FROM track_artists ta
    JOIN artists a ON a.spotify_id = ta.artist_id
    WHERE ta.position = 0
  `);
  const pct = (n) => ((n / primaries.total) * 100).toFixed(1);

  console.log(`Imported from ${cacheDir}`);
  console.log(`  artists            ${artistCount} from cache, ${q('SELECT count(*) n FROM artists').n} total (incl. featured credits)`);
  console.log(`  of those resolved  ${resolved}`);
  console.log(`  tracks             ${trackCount}`);
  console.log(`  track-artist links ${linkCount}`);
  console.log(`\nCoverage over ${primaries.total} primary-artist tracks (must match the CSV):`);
  console.log(`  city    ${primaries.city} (${pct(primaries.city)}%)`);
  console.log(`  country ${primaries.country} (${pct(primaries.country)}%)`);
  console.log(`\nStill needed for map + genres: MB area IDs and genre IDs, which the`);
  console.log(`CLI never stored. That is one enrichment pass, not a re-resolve.`);
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
} finally {
  db.close();
}
