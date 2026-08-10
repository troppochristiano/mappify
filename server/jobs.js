// The import pipeline, as one interruptible job with observable progress.
//
// Order matters: the shared index resolves most artists in a couple of seconds,
// and only what it misses falls through to the live MusicBrainz path at its hard
// 1 request/second. That is the difference between an import that finishes while
// you watch and one that takes 22 minutes.

import { reindexSearch } from './db.js';
import { currentDb, currentUserId } from './context.js';
import { lookupArtists, indexAvailable } from './mbindex.js';
import {
  syncPlacesFromIndex,
  syncDerivedArtists,
  syncDerivedPlaces,
  collapseWrappers,
} from './places-sync.js';
import { resolveScenes } from './scenes.js';
import { lookupBySpotifyUrl, lookupArtist } from './musicbrainz.js';
import {
  fetchLiked,
  fetchPlaylists,
  fetchPlaylistItems,
  fetchSavedAlbums,
  me,
} from './sources/spotify.js';

const LIKED_KEY = 'liked:me';

/** Artists between map refreshes during the slow pass — roughly 25 seconds. */
const CHECKPOINT_EVERY = Number(process.env.MAPPIFY_MAP_CHECKPOINT ?? 25);

/**
 * One in-flight job per user; the UI polls `status`.
 *
 * This was a single module-level `current`, which on a shared instance means one
 * person's import blocks everyone else's and reports its progress to all of
 * them. Keyed by user now, and every read goes through the async-scoped context
 * so a job cannot be observed or cancelled by anyone but its owner.
 */
const jobs = new Map();
const jobFor = () => jobs.get(currentUserId()) ?? null;

/**
 * Whether *anybody's* import is in flight.
 *
 * The one function here that reads `jobs` from outside the async-scoped context,
 * and the reason it returns a bare boolean: the rule above is that a job must
 * not be observable across users, and "yes, something is running" says nothing
 * about whose, which phase, or how far along. Do not grow the return value.
 *
 * Used only by the idle-shutdown sweeper, which must not pull the floor out from
 * under a 20-minute import running for someone else.
 */
export function anyRunning() {
  for (const job of jobs.values()) if (job.running) return true;
  return false;
}

/**
 * Marks that what the map draws has changed on disk.
 *
 * The client watches this number rather than guessing from `phase`: it ticks
 * once per real change, so an effect keyed on it refreshes exactly when there is
 * something new and never loops.
 */
const bumpRevision = () => {
  const job = jobFor();
  if (job) job.revision++;
};

/**
 * Folds any duplicate Liked Songs sources into one. Earlier imports keyed it on
 * NULL, which SQLite never matches against itself, so re-importing multiplied
 * the source rather than updating it.
 */
export function repairLikedSources(db) {
  const rows = db.prepare("SELECT id FROM sources WHERE kind = 'liked' ORDER BY id").all();
  if (rows.length < 2) {
    db.prepare("UPDATE sources SET spotify_id = ? WHERE kind = 'liked' AND spotify_id IS NULL").run(LIKED_KEY);
    return 0;
  }
  const keep = rows[0].id;
  const drop = rows.slice(1).map((r) => r.id);
  db.exec('BEGIN');
  for (const id of drop) {
    db.prepare('UPDATE OR IGNORE track_sources SET source_id = ? WHERE source_id = ?').run(keep, id);
    db.prepare('DELETE FROM track_sources WHERE source_id = ?').run(id);
    db.prepare('DELETE FROM sources WHERE id = ?').run(id);
  }
  db.prepare('UPDATE sources SET spotify_id = ? WHERE id = ?').run(LIKED_KEY, keep);
  db.exec('COMMIT');
  return drop.length;
}

export function status() {
  return (
    jobFor() ?? {
      running: false, phase: 'idle', done: 0, total: 0, message: null, finishedAt: null,
      // Stable zero for a client that has never imported, so the effect watching
      // it has something to compare against from the first render.
      revision: 0,
      mapReadyAt: null,
    }
  );
}

const set = (patch) => {
  const job = jobFor();
  if (job) Object.assign(job, patch);
};

function upsertTracks(db, sourceId, tracks) {
  const track = db.prepare(
    `INSERT INTO tracks (spotify_id, name, album, uri, url, duration_ms, image_url)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(spotify_id) DO UPDATE SET
       name=excluded.name, album=excluded.album, uri=excluded.uri,
       url=excluded.url, duration_ms=excluded.duration_ms,
       image_url=COALESCE(excluded.image_url, tracks.image_url)`
  );
  const stubArtist = db.prepare(
    'INSERT INTO artists (spotify_id, name) VALUES (?,?) ON CONFLICT(spotify_id) DO UPDATE SET name=excluded.name'
  );
  const link = db.prepare(
    'INSERT OR REPLACE INTO track_artists (track_id, artist_id, position) VALUES (?,?,?)'
  );
  const inSource = db.prepare(
    'INSERT OR REPLACE INTO track_sources (track_id, source_id, added_at) VALUES (?,?,?)'
  );

  db.exec('BEGIN');
  for (const t of tracks) {
    track.run(t.id, t.name, t.album ?? null, t.uri ?? null, t.url ?? null, t.durationMs ?? null, t.albumImage ?? null);
    inSource.run(t.id, sourceId, t.addedAt ?? null);
    t.artists.forEach((a, i) => {
      stubArtist.run(a.id, a.name ?? '');
      link.run(t.id, a.id, i);
    });
  }
  db.exec('COMMIT');
}

function upsertSource(db, { kind, spotifyId, name, ownerId, snapshotId, trackTotal, image, owned, note }) {
  db.prepare(
    `INSERT INTO sources (kind, spotify_id, name, owner_id, snapshot_id, track_total, image_url, owned, note, last_synced_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(spotify_id) DO UPDATE SET
       name=excluded.name, owner_id=excluded.owner_id, snapshot_id=excluded.snapshot_id,
       track_total=excluded.track_total, image_url=excluded.image_url,
       owned=excluded.owned, note=excluded.note, last_synced_at=excluded.last_synced_at`
  ).run(
    kind, spotifyId ?? null, name, ownerId ?? null, snapshotId ?? null,
    trackTotal ?? null, image ?? null, owned ? 1 : 0, note ?? null, new Date().toISOString()
  );
  return db.prepare('SELECT id FROM sources WHERE spotify_id = ?').get(spotifyId)?.id;
}

/**
 * Resolve origins for every artist that has none yet. Index first, live API for
 * the remainder — and the live path is what makes this slow, so it is reported
 * separately in the progress so the wait is never mysterious.
 */
/**
 * Turn resolved areas into the place rows the map and tree actually draw.
 *
 * Four idempotent upsert passes that used to sit inline at the end of an import.
 * They are here as one named step because the map now wants them *twice*: once
 * the moment the shared index has answered, and once properly at the end.
 *
 * `quick` is the difference between the two:
 *   - it skips the Wikidata tail inside syncPlacesFromIndex, which is the only
 *     network hop in the block and the thing that would make "show the dots
 *     immediately" wait on a SPARQL round trip
 *   - it skips collapseWrappers, which needs a complete graph to judge and has
 *     nothing useful to say about a half-built one
 *
 * Measured against the bundled index: about a tenth of a second.
 */
async function materialisePlaces(db, { quick = false } = {}) {
  const artists = await syncDerivedArtists(db);
  const synced = await syncPlacesFromIndex(db, { network: !quick });
  const derived = await syncDerivedPlaces(db);
  const collapse = quick ? { collapsed: 0, skipped: 0 } : collapseWrappers(db);
  return { artists, synced, derived, collapse };
}

/**
 * @param {object} [opts]
 * @param {() => Promise<void>} [opts.onCheckpoint] called once the shared index
 *   has answered, and periodically through the slow pass. The caller uses it to
 *   put dots on the map while this is still working; this function stays
 *   ignorant of place tables, since it is also useful on its own.
 */
export async function resolveOrigins(db, { liveFallback = true, onCheckpoint = null } = {}) {
  const pending = db
    .prepare(
      `SELECT a.spotify_id, a.name FROM artists a
       WHERE a.origin_resolved_at IS NULL
         AND EXISTS (SELECT 1 FROM track_artists ta WHERE ta.artist_id = a.spotify_id)`
    )
    .all();
  if (!pending.length) return { fromIndex: 0, fromLive: 0, unresolved: 0 };

  set({ phase: 'origins', done: 0, total: pending.length, message: 'matching artists to places' });

  const write = db.prepare(
    `UPDATE artists SET mbid=?, artist_type=?, mb_begin_area_id=?, mb_area_id=?,
            mb_country_iso=?, mb_city=?, mb_country=?, status=?, source=?, origin_resolved_at=?
     WHERE spotify_id=?`
  );

  let fromIndex = 0;
  if (await indexAvailable()) {
    const found = await lookupArtists(pending.map((a) => a.spotify_id));
    const stamp = new Date().toISOString();
    db.exec('BEGIN');
    for (const [id, a] of found) {
      write.run(
        a.mbid, a.type, a.beginAreaId, a.areaId, a.countryIso,
        a.city, a.country,
        a.city || a.country ? 'ok' : 'no-area',
        'index', stamp, id
      );
      fromIndex++;
    }
    db.exec('COMMIT');
    set({ done: fromIndex, message: `${fromIndex} matched instantly from the shared index` });

    // The moment worth hurrying: everything the index knows is on disk, and for
    // a typical library that is 70% of the dots. Committed first, so the
    // checkpoint reads settled rows rather than an open transaction.
    await onCheckpoint?.();
  }

  const left = db
    .prepare(
      `SELECT a.spotify_id, a.name FROM artists a
       WHERE a.origin_resolved_at IS NULL
         AND EXISTS (SELECT 1 FROM track_artists ta WHERE ta.artist_id = a.spotify_id)`
    )
    .all();

  let fromLive = 0;
  // Counted separately from `attempted`: an artist MusicBrainz has never heard of
  // is still processed. Reporting only successes made a finished import read
  // "32/319" and look stuck.
  let attempted = fromIndex;
  if (liveFallback && left.length) {
    set({
      phase: 'origins-live',
      done: fromIndex,
      total: pending.length,
      message: `${left.length} not in the index — looking those up at 1/second`,
    });
    for (const artist of left) {
      if (jobFor()?.cancelled) break;
      try {
        const byUrl = await lookupBySpotifyUrl(artist.spotify_id);
        const rel = (byUrl.json?.relations ?? []).find((r) => r.artist?.id);
        const stamp = new Date().toISOString();
        if (!rel) {
          write.run(null, null, null, null, null, null, null, 'no-mb-match', null, stamp, artist.spotify_id);
        } else {
          const { json: a } = await lookupArtist(rel.artist.id);
          const city = a?.['begin-area']?.name ?? null;
          const country = a?.area?.name ?? null;
          write.run(
            rel.artist.id, a?.type ?? null,
            a?.['begin-area']?.id ?? null, a?.area?.id ?? null, a?.country ?? null,
            city, country,
            city || country ? 'ok' : 'no-area', 'musicbrainz', stamp, artist.spotify_id
          );
          fromLive++;
        }
      } catch (err) {
        set({ message: `${artist.name}: ${err.message}` });
      }
      attempted++;
      set({ done: attempted });

      // Every so often, not every artist: a checkpoint writes a few hundred rows
      // synchronously and node:sqlite blocks the event loop while it does, so
      // doing it per artist would stall every request for the length of the
      // import. Once a minute or so is invisible and keeps the globe filling in.
      if (attempted % CHECKPOINT_EVERY === 0) await onCheckpoint?.();
    }
    // Whatever the last partial batch resolved, before the caller moves on.
    if (!jobFor()?.cancelled) await onCheckpoint?.();
  }

  const unresolved = db
    .prepare('SELECT count(*) n FROM artists WHERE origin_resolved_at IS NULL')
    .get().n;
  return { fromIndex, fromLive, unresolved };
}

/** Full import: Liked Songs + every playlist, then origins. */
export async function runImport({ liveFallback = true } = {}) {
  if (jobFor()?.running) throw new Error('An import is already running.');
  const userId = currentUserId();
  jobs.set(userId, {
    running: true, phase: 'starting', done: 0, total: 0,
    message: null, startedAt: new Date().toISOString(), finishedAt: null,
    cancelled: false, summary: null,
    // Ticks whenever the map data changes, which is what the client watches.
    revision: 0,
    mapReadyAt: null,
  });

  // The caller's own database, never openDb(): an import writes a whole library,
  // and writing it into the wrong file is the worst thing this server could do.
  // It is also not closed here — the handle is shared and cached per user, and
  // closing it out from under a concurrent request is how a read fails mid-page.
  const db = currentDb();
  try {
    const merged = repairLikedSources(db);
    if (merged) set({ message: `merged ${merged} duplicate Liked Songs source(s)` });
    const profile = await me();
    set({ phase: 'liked', message: 'reading Liked Songs' });

    const liked = await fetchLiked({
      onProgress: (n, total) => set({ done: n, total, message: `${n} of ${total} liked songs` }),
    });
    // A stable synthetic key, not NULL: SQLite treats NULLs as distinct in a
    // UNIQUE column, so ON CONFLICT never fired and every import created another
    // "Liked Songs" source.
    const likedId = upsertSource(db, {
      kind: 'liked', spotifyId: LIKED_KEY, name: 'Liked Songs',
      trackTotal: liked.tracks.length, owned: true,
    });
    upsertTracks(db, likedId, liked.tracks);

    set({ phase: 'playlists', done: 0, total: 0, message: 'listing playlists' });
    const playlists = await fetchPlaylists();
    set({ total: playlists.length });

    const unreadable = [];
    let i = 0;
    for (const p of playlists) {
      if (jobFor()?.cancelled) break;
      i++;
      set({ done: i, message: `${p.name}` });

      const existing = db.prepare('SELECT id, snapshot_id FROM sources WHERE spotify_id = ?').get(p.id);
      const owned = p.ownerId === profile.id || p.collaborative;

      // Spotify only returns items for playlists you own or collaborate on, so a
      // followed playlist is recorded with its cover and an explicit reason
      // rather than appearing as an empty playlist that looks like a bug.
      const note = owned ? null : 'Spotify does not return tracks for playlists you do not own';
      const sourceId = upsertSource(db, {
        kind: 'playlist', spotifyId: p.id, name: p.name, ownerId: p.ownerId,
        snapshotId: p.snapshotId, trackTotal: p.trackTotal, image: p.image, owned, note,
      });

      if (!owned) {
        unreadable.push({ name: p.name, owner: p.ownerName, tracks: p.trackTotal });
        continue;
      }
      if (existing?.snapshot_id && existing.snapshot_id === p.snapshotId) continue; // unchanged

      const { tracks, readable } = await fetchPlaylistItems(p.id);
      if (!readable) {
        unreadable.push({ name: p.name, owner: p.ownerName, tracks: p.trackTotal });
        continue;
      }
      upsertTracks(db, sourceId, tracks);
    }

    // Saved albums are a third source: a saved album is as much "in my library"
    // as a liked song, and its tracks carry the same artists.
    set({ phase: 'albums', done: 0, total: 0, message: 'reading saved albums' });
    const { albums } = await fetchSavedAlbums({
      onProgress: (n, total) => set({ done: n, total, message: `${n} of ${total} saved albums` }),
    });
    for (const al of albums) {
      if (jobFor()?.cancelled) break;
      const sourceId = upsertSource(db, {
        kind: 'album',
        spotifyId: `album:${al.id}`,
        name: al.name,
        ownerId: al.artistNames,
        trackTotal: al.trackTotal,
        image: al.image,
        owned: true,
      });
      upsertTracks(db, sourceId, al.tracks);
    }

    // How many artists had a resolved area last time the map was rebuilt. A
    // checkpoint that would draw exactly what is already on screen is skipped —
    // during a long run of artists MusicBrainz has never heard of, that is all
    // of them.
    let placedAtLastCheckpoint = -1;
    const areasResolved = () =>
      db.prepare('SELECT count(*) n FROM artists WHERE mb_begin_area_id IS NOT NULL').get().n;

    const origins = await resolveOrigins(db, {
      liveFallback,
      onCheckpoint: async () => {
        if (jobFor()?.cancelled) return;
        const placed = areasResolved();
        if (placed === placedAtLastCheckpoint) return;
        placedAtLastCheckpoint = placed;

        await materialisePlaces(db, { quick: true });
        // Deliberately does not touch phase, done or total: the progress bar is
        // reporting the origins pass, and having it jump to something else every
        // 25 artists would read as thrashing.
        set({ mapReadyAt: jobFor()?.mapReadyAt ?? new Date().toISOString() });
        bumpRevision();
      },
    });

    // Every artist now has an area id; turn those into place rows so the tree and
    // the map can see them. Skipping this is what left real cities in Unknown.
    //
    // The checkpoints above have already done the local half several times over;
    // this is the run that also chases the area-less tail through Wikidata and
    // folds administrative shells into the cities they wrap.
    set({ phase: 'places', message: 'placing cities on the map' });
    const { artists, synced, derived, collapse } = await materialisePlaces(db);
    if (derived.dangling) {
      console.log(`  ! ${derived.dangling} artist(s) point at a place the index could not supply`);
    }
    bumpRevision(); // shells merged, so dots moved

    // Whatever the index could not answer, work out here — the categories pass
    // that put 2Pac in Baltimore. Only artists nobody has resolved yet reach
    // this, so a second import costs nothing and a first one pays once.
    //
    // Bounded, because this is the only part of an import that scales with
    // artists nobody has ever looked at: a fresh 2000-artist library would spend
    // minutes on Wikipedia while someone watches a progress bar. Most-played
    // first, and what is left is said out loud rather than quietly dropped.
    const sceneLimit = Number(process.env.MAPPIFY_SCENES_LIMIT ?? 300);
    let sceneMoves = 0;
    if (sceneLimit > 0) {
      set({ phase: 'scenes', message: 'looking up where artists are from' });
      try {
        const scenes = await resolveScenes(db, {
          limit: sceneLimit,
          log: (m) => console.log(`  ${m}`),
        });
        sceneMoves = scenes.moved.length;
        const left = db
          .prepare(
            `SELECT count(*) n FROM artists a
              WHERE a.mbid IS NOT NULL AND a.mbid <> ''
                AND a.origin_wiki_qid IS NULL AND a.origin_override_qid IS NULL
                AND EXISTS (SELECT 1 FROM track_artists ta WHERE ta.artist_id = a.spotify_id)`
          )
          .get().n;
        console.log(
          `  ${scenes.moved.length} artist(s) moved to a scene` +
            (left ? `; ${left} still unplaced — node tools/fix-artist-scenes.js covers the rest` : '')
        );
      } catch (err) {
        // Never fail an import over an enrichment: the library is already in.
        console.log(`  ! scene pass skipped: ${err.message}`);
      }
    }
    const scenesTotal = artists.origins + sceneMoves;
    set({
      message:
        `${synced.places} places, ${collapse.collapsed} shells folded in` +
        (scenesTotal ? `, ${scenesTotal} placed by scene` : ''),
    });
    if (sceneMoves) bumpRevision(); // artists moved city, so dots moved

    reindexSearch(db);

    const totals = db
      .prepare(
        `SELECT (SELECT count(*) FROM tracks) tracks,
                (SELECT count(*) FROM artists WHERE status IS NOT NULL) artists,
                (SELECT count(*) FROM sources WHERE kind='playlist') playlists,
                (SELECT count(*) FROM sources WHERE kind='album') albums`
      )
      .get();

    set({
      running: false, phase: 'done', finishedAt: new Date().toISOString(),
      message: 'import complete',
      summary: { ...totals, ...origins, skippedPlaylists: unreadable, likedSkipped: liked.skipped },
    });
    // One last tick, so a client that happened to miss an intermediate poll
    // still refreshes rather than sitting on a stale globe.
    bumpRevision();
    return jobFor().summary;
  } catch (err) {
    set({ running: false, phase: 'error', message: String(err.message ?? err), finishedAt: new Date().toISOString() });
    throw err;
  }
}

export function cancel() {
  const job = jobFor();
  if (job?.running) {
    job.cancelled = true;
    set({ message: 'stopping after the current item…' });
    return true;
  }
  return false;
}
