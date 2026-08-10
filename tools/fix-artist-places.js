/**
 * Put artists on the map whose origin is a place name we already know, sitting
 * in the wrong column.
 *
 * MusicBrainz hands back a begin-area as a name even when it gives no area ID,
 * and the importer files that name under `mb_country` when there is no separate
 * city. So ANOTR carries `mb_country = "Amsterdam"` with no city at all, and
 * lands in "City unknown" under the Netherlands. Others carry a real city with a
 * supranational area beside it: merope is `Rotterdam` in `Europe`, whose ISO is
 * the user-assigned XE, which the tree then renders as a country of its own.
 *
 * Both are the same shape — a place we have on the map, named in a field nothing
 * reads as a place. This matches those names against the places table and
 * attaches the artist properly.
 *
 * Two rules keep it honest:
 *
 *   - A name that is simply the artist's own country ("Japan", "United States")
 *     is left alone. Those artists really are country-only, and attaching them
 *     to a country-shaped "place" would plant a city dot in the middle of a
 *     nation and claim the music came from there.
 *   - An ambiguous name is only taken when the artist's own country picks a
 *     single candidate. "Olympia" and "Siracusa" exist in more than one country,
 *     and a coin flip is worse than leaving it unresolved.
 *
 * Everything it touches is stamped `source = 'name-match'`, so a row placed by
 * its name is never mistaken for one resolved through an area ID.
 *
 * Run: node tools/fix-artist-places.js [--dry-run]
 */
import '../server/env.js';
import { openDb } from '../server/db.js';
import { sparql } from '../server/wikidata.js';

const db = openDb();
const apply = !process.argv.includes('--dry-run');
const regionName = (iso) => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(iso) ?? null;
  } catch {
    return null;
  }
};

// ---- 1. Fill in country_iso where a place has none ------------------------
// Without it a place lands under "Unknown" in the tree no matter who is from
// there, which would just move the problem rather than fix it.
const isoless = db
  .prepare("SELECT qid, name FROM places WHERE country_iso IS NULL AND qid LIKE 'Q%'")
  .all();

if (isoless.length) {
  console.log(`Resolving country for ${isoless.length} place(s) with no ISO.`);
  const V = isoless.map((p) => `wd:${p.qid}`).join(' ');
  // Three ways in, because the ISO is not always one hop away. A country holds
  // its own code (Sweden, Jamaica). A city usually gets it from P17. But some
  // countries carry no truthy P297 themselves — the Netherlands is one, its code
  // living on the Kingdom of the Netherlands above it — so Amsterdam and
  // Rotterdam need a second hop. Every pattern still hangs off a bound subject.
  const q = `SELECT ?place ?iso1 ?iso2 ?iso3 WHERE {
    VALUES ?place { ${V} }
    OPTIONAL { ?place wdt:P297 ?iso1 }
    OPTIONAL { ?place wdt:P17 ?c1 . ?c1 wdt:P297 ?iso2 }
    OPTIONAL { ?place wdt:P17 ?c2 . ?c2 wdt:P17 ?c3 . ?c3 wdt:P297 ?iso3 }
  }`;
  try {
    const json = await sparql(q);
    const setIso = db.prepare('UPDATE places SET country_iso = ? WHERE qid = ?');
    const seen = new Set();
    for (const b of json.results.bindings) {
      const qid = b.place.value.split('/').pop();
      if (seen.has(qid)) continue;
      const iso = b.iso1?.value ?? b.iso2?.value ?? b.iso3?.value;
      if (!iso) continue;
      seen.add(qid);
      console.log(`  ${isoless.find((p) => p.qid === qid)?.name ?? qid} -> ${iso}`);
      if (apply) setIso.run(iso, qid);
    }
    const missed = isoless.filter((p) => !seen.has(p.qid)).map((p) => p.name);
    if (missed.length) console.log(`  no country in Wikidata: ${missed.join(', ')}`);
  } catch (err) {
    console.log(`  ! ISO lookup failed: ${err.message}`);
  }
}

// ---- 2. Attach artists whose origin names a place we already have ---------
const ARTIST_PLACE = `COALESCE(
  (SELECT COALESCE(p.merged_into, p.qid) FROM place_areas pa
     JOIN places p ON p.qid = pa.qid WHERE pa.mb_area_id = a.mb_begin_area_id),
  (SELECT COALESCE(p2.merged_into, p2.qid) FROM places p2 WHERE p2.qid = a.place_qid))`;

const unplaced = db
  .prepare(
    `SELECT a.spotify_id, a.name, a.mb_city, a.mb_country, a.mb_country_iso
       FROM artists a
      WHERE ${ARTIST_PLACE} IS NULL
        AND COALESCE(a.mb_city, a.mb_country) IS NOT NULL
        AND EXISTS (SELECT 1 FROM track_artists ta WHERE ta.artist_id = a.spotify_id)`
  )
  .all();

const byName = new Map();
for (const p of db.prepare('SELECT qid, name, country_iso FROM places WHERE lat IS NOT NULL').all()) {
  const k = p.name.toLowerCase();
  if (!byName.has(k)) byName.set(k, []);
  byName.get(k).push(p);
}

const attach = db.prepare("UPDATE artists SET place_qid = ?, source = 'name-match' WHERE spotify_id = ?");
const done = [];
let skippedCountryName = 0;
let skippedAmbiguous = 0;
let skippedNoMatch = 0;
let skippedWrongCountry = 0;

for (const a of unplaced) {
  const raw = a.mb_city ?? a.mb_country;
  const candidate = raw.toLowerCase();

  // "Japan" under JP is a country, not a town. Leave it in the cityless bucket.
  const own = a.mb_country_iso ? regionName(a.mb_country_iso) : null;
  if (own && candidate === own.toLowerCase()) {
    skippedCountryName++;
    continue;
  }

  const hits = byName.get(candidate) ?? [];
  if (!hits.length) {
    skippedNoMatch++;
    continue;
  }

  let pick = hits[0];
  if (hits.length > 1) {
    const sameCountry = hits.filter((h) => h.country_iso && h.country_iso === a.mb_country_iso);
    if (sameCountry.length !== 1) {
      skippedAmbiguous++;
      continue;
    }
    pick = sameCountry[0];
  }

  // A lone match is still the wrong one if it is in the wrong country. Our map
  // holds Rome, Georgia but files the Italian capital under "Roma", so an
  // Italian artist from "Rome" matched exactly one place — in the United States.
  // Where both sides name a country and they disagree, trust neither.
  if (pick.country_iso && a.mb_country_iso && pick.country_iso !== a.mb_country_iso) {
    skippedWrongCountry++;
    continue;
  }

  done.push({ artist: a.name, from: raw, to: pick.name, iso: pick.country_iso });
  if (apply) attach.run(pick.qid, a.spotify_id);
}

console.log('');
console.log(`${unplaced.length} unplaced artist(s) naming somewhere:`);
console.log(`  ${done.length} ${apply ? 'attached' : 'would attach'}`);
console.log(`  ${skippedCountryName} left alone — the name is just their country`);
console.log(`  ${skippedAmbiguous} left alone — the name is ambiguous`);
console.log(`  ${skippedWrongCountry} left alone — the only match is in another country`);
console.log(`  ${skippedNoMatch} left alone — no place of that name on the map`);
console.log('');
for (const d of done.slice(0, 20)) {
  console.log(`  ${d.artist}: "${d.from}" -> ${d.to} (${d.iso ?? 'no iso'})`);
}
if (done.length > 20) console.log(`  ...and ${done.length - 20} more`);
if (!apply) console.log('\n(dry run — nothing written)');
