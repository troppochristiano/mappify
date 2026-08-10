// Enrichment pass: fills in what the CLI never stored — MusicBrainz area IDs
// (which are how we get real coordinates and the place hierarchy).
//
// Both ride on one artist call each, so this costs the same 1 req/s as the
// original resolve did. Resumable: an artist is stamped only once settled, and
// every artist is committed immediately, so Ctrl+C loses at most one lookup.
//
//   node server/enrich.js [--limit N]

import { openDbForCli, reindexSearch } from './db.js';
import { lookupArtist } from './musicbrainz.js';

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;

const db = openDbForCli();

const todo = db
  .prepare(
    `SELECT spotify_id, name, mbid FROM artists
     WHERE mbid IS NOT NULL AND origin_resolved_at IS NULL
     ORDER BY (SELECT count(*) FROM track_artists ta WHERE ta.artist_id = spotify_id) DESC`
  )
  .all()
  .slice(0, LIMIT === Infinity ? undefined : LIMIT);

if (!todo.length) {
  console.log('Nothing to enrich.');
  db.close();
  process.exit(0);
}

console.log(
  `Enriching ${todo.length} artist(s) at ~1.1s each (~${Math.ceil((todo.length * 1.1) / 60)} min).\n` +
    `Ctrl+C is safe — every artist is committed as it lands.`
);

const setArtist = db.prepare(
  `UPDATE artists SET mb_begin_area_id = ?, mb_area_id = ?, artist_type = COALESCE(?, artist_type),
                      origin_resolved_at = ? WHERE spotify_id = ?`
);

let done = 0;
let withArea = 0;

let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
  console.log('\nStopping after the current artist…');
});

for (const artist of todo) {
  if (stopping) break;
  try {
    const { json: a } = await lookupArtist(artist.mbid);
    const beginArea = a?.['begin-area']?.id ?? null;
    const area = a?.area?.id ?? null;
    setArtist.run(beginArea, area, a?.type ?? null, new Date().toISOString(), artist.spotify_id);
    if (beginArea || area) withArea++;


    done++;
    if (done % 25 === 0 || done === todo.length) {
      console.log(`  [${done}/${todo.length}] areas ${withArea} — last: ${artist.name}`);
    }
  } catch (err) {
    console.log(`  ! ${artist.name}: ${err.message}`);
    // No stamp written, so the artist stays queued for the next run.
  }
}

reindexSearch(db);
const areas = db.prepare('SELECT count(DISTINCT mb_begin_area_id) n FROM artists WHERE mb_begin_area_id IS NOT NULL').get().n;
console.log(`\nDone. ${done} artist(s) enriched.`);
console.log(`  distinct MB areas   ${areas}`);
db.close();
