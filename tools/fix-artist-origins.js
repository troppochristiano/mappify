/**
 * Move artists from where they were born to where they are *from*.
 *
 * MusicBrainz's begin-area is a birthplace for a person, which is why Kanye West
 * sat in Atlanta and MF DOOM in London — both true, neither what anyone means by
 * where the music came from. Nothing in MusicBrainz or Wikidata fixes it at any
 * useful rate: MusicBrainz's other area field is just the country, Wikidata's
 * work location covers 5% of people and its residence 10%, ambiguously.
 *
 * An English Wikipedia musician infobox has an `origin` field that means exactly
 * "where the act is from", and 96% of these artists have an article. Measured
 * over the 200 busiest: 31.5% carry the field and 24.5% carry one that differs
 * from the birthplace — Kanye to Chicago, MF DOOM to Long Beach, Aphex Twin from
 * Limerick to Cornwall, Nas from New York City to Queens.
 *
 * The rest keep their birthplace. This narrows the problem rather than solving
 * it, and a value is only ever taken when it resolves to a place already on the
 * map, in the country the artist is already filed under.
 *
 * Writes to its own column, never to the manual pin: a correction you made by
 * hand still beats this, and a row can say which of the two placed it.
 *
 *   node tools/fix-artist-origins.js [--dry-run] [--limit N]
 *   node tools/fix-artist-origins.js --revert     # clear every Wikipedia origin
 */
import '../server/env.js';
import { openDb } from '../server/db.js';
import { sparql } from '../server/wikidata.js';

const db = openDb();
const args = process.argv.slice(2);
const apply = !args.includes('--dry-run');
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) : 1000;

if (args.includes('--revert')) {
  const n = db.prepare('SELECT count(*) n FROM artists WHERE origin_wiki_qid IS NOT NULL').get().n;
  db.prepare('UPDATE artists SET origin_wiki_qid = NULL').run();
  console.log(`Cleared ${n} Wikipedia origin(s). Manual pins are untouched.`);
  process.exit(0);
}

// People only. For a group, begin_area already means where it formed, and the
// infobox origin would say the same thing less precisely.
const people = db
  .prepare(
    `SELECT spotify_id, name, mbid, mb_country_iso FROM artists
      WHERE artist_type = 'Person' AND mbid IS NOT NULL AND mbid <> ''
        AND EXISTS (SELECT 1 FROM track_artists ta WHERE ta.artist_id = spotify_id)
      ORDER BY (SELECT count(*) FROM track_artists ta WHERE ta.artist_id = spotify_id) DESC
      LIMIT ?`
  )
  .all(LIMIT);

console.log(`${people.length} people to check.`);

// ---- mbid -> English Wikipedia article --------------------------------------
const titleOf = new Map();
for (let i = 0; i < people.length; i += 100) {
  const V = people.slice(i, i + 100).map((p) => `"${p.mbid}"`).join(' ');
  try {
    const j = await sparql(`SELECT ?mb ?article WHERE {
      VALUES ?mb { ${V} }
      ?person wdt:P434 ?mb .
      ?article schema:about ?person ; schema:isPartOf <https://en.wikipedia.org/> .
    }`);
    for (const b of j.results.bindings) {
      titleOf.set(
        b.mb.value,
        decodeURIComponent(b.article.value.split('/wiki/')[1]).replace(/_/g, ' ')
      );
    }
  } catch (err) {
    console.log(`  ! article lookup failed: ${err.message}`);
  }
}
console.log(`  ${titleOf.size} have an English Wikipedia article.`);

// ---- article -> infobox origin ----------------------------------------------
const wikitext = new Map();
const titles = [...new Set(titleOf.values())];
for (let i = 0; i < titles.length; i += 40) {
  const batch = titles.slice(i, i + 40);
  const url =
    'https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content' +
    '&rvslots=main&format=json&redirects=1&titles=' +
    encodeURIComponent(batch.join('|'));
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'mappify/0.1 (personal music map)' } });
    const d = await res.json();
    for (const p of Object.values(d.query.pages)) {
      wikitext.set(p.title, p.revisions?.[0]?.slots?.main?.['*'] ?? '');
    }
    // Titles change shape on the way in; map both aliases back to the content.
    for (const n of [...(d.query.normalized ?? []), ...(d.query.redirects ?? [])]) {
      if (wikitext.has(n.to)) wikitext.set(n.from, wikitext.get(n.to));
    }
  } catch (err) {
    console.log(`  ! wikitext batch failed: ${err.message}`);
  }
  process.stdout.write(`\r  fetched ${Math.min(i + 40, titles.length)}/${titles.length} articles`);
}
console.log('');

/**
 * The value of one infobox field.
 *
 * Read only inside the infobox: citation templates further down the article
 * carry their own `|` lines, and a naive scan of the whole page pulled
 * `url-status=live` out of a reference and offered it as somebody's home town.
 */
function infoboxField(text, key) {
  const start = /\{\{\s*Infobox\s+musical\s+artist/i.exec(text ?? '');
  if (!start) return null;
  let depth = 0;
  let end = start.index;
  for (let i = start.index; i < text.length - 1; i++) {
    if (text[i] === '{' && text[i + 1] === '{') depth++;
    else if (text[i] === '}' && text[i + 1] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const box = text.slice(start.index, end);
  for (const line of box.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    if (t.slice(1, eq).trim().toLowerCase() !== key) continue;
    const raw = t
      .slice(eq + 1)
      .split('<ref')[0]
      .replace(/\{\{[^{}]*\|([^{}|]*)\}\}/g, '$1')
      .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
      .replace(/<[^>]*>/g, '')
      .replace(/[{}]/g, '')
      .trim();
    return raw || null;
  }
  return null;
}

// ---- resolve the free text to a place already on the map --------------------
const byName = new Map();
for (const p of db
  .prepare('SELECT qid, name, country_iso FROM places WHERE lat IS NOT NULL AND merged_into IS NULL')
  .all()) {
  const k = p.name.toLowerCase();
  if (!byName.has(k)) byName.set(k, []);
  byName.get(k).push(p);
}

const regionName = (iso) => {
  try {
    return iso ? new Intl.DisplayNames(['en'], { type: 'region' }).of(iso) : null;
  } catch {
    return null;
  }
};

/**
 * The place named by an origin like "Queens, New York City, U.S.".
 *
 * Only the first segment is ever taken, and only if it is a city we already
 * draw. Walking up the rest of the string looks helpful and is not: where the
 * town is missing from the map it lands on whatever is next along, which is a
 * county, a state or a country. That put Aphex Twin on "England", Tame Impala on
 * "Australia" and Piero Umiliani on "Italy" — each of them a precise birthplace
 * traded for a blob. Leaving those artists where they were is the better answer.
 */
function resolve(origin, iso) {
  const first = origin.split(',')[0].trim();
  if (!first || /^u\.?\s?s\.?a?\.?$/i.test(first)) return null;

  const hits = byName.get(first.toLowerCase()) ?? [];
  if (!hits.length) return null;

  let pick = hits[0];
  if (hits.length > 1) {
    const same = hits.filter((h) => h.country_iso && h.country_iso === iso);
    if (same.length !== 1) return null; // ambiguous, and no country to break the tie
    pick = same[0];
  }
  // A lone match in the wrong country is still the wrong match.
  if (pick.country_iso && iso && pick.country_iso !== iso) return null;
  // A country wearing a city's clothes: an origin of "Italy" resolves to the
  // place called Italy, which is a step backwards from any town.
  if (regionName(pick.country_iso) === pick.name) return null;
  return pick;
}

const write = db.prepare('UPDATE artists SET origin_wiki_qid = ? WHERE spotify_id = ?');
const moved = [];
let noArticle = 0, noOrigin = 0, unresolved = 0, sameAsNow = 0;

const currentPlace = db.prepare(
  `SELECT COALESCE(
     (SELECT COALESCE(p.merged_into, p.qid) FROM place_areas pa JOIN places p ON p.qid = pa.qid
       WHERE pa.mb_area_id = a.mb_begin_area_id),
     (SELECT COALESCE(p2.merged_into, p2.qid) FROM places p2 WHERE p2.qid = a.place_qid)
   ) qid,
   (SELECT name FROM places WHERE qid = COALESCE(
     (SELECT COALESCE(p.merged_into, p.qid) FROM place_areas pa JOIN places p ON p.qid = pa.qid
       WHERE pa.mb_area_id = a.mb_begin_area_id),
     (SELECT COALESCE(p2.merged_into, p2.qid) FROM places p2 WHERE p2.qid = a.place_qid))) name
   FROM artists a WHERE a.spotify_id = ?`
);

for (const p of people) {
  const title = titleOf.get(p.mbid);
  if (!title) {
    noArticle++;
    continue;
  }
  const origin = infoboxField(wikitext.get(title), 'origin');
  if (!origin) {
    noOrigin++;
    continue;
  }
  const place = resolve(origin, p.mb_country_iso);
  if (!place) {
    unresolved++;
    continue;
  }
  const now = currentPlace.get(p.spotify_id);
  if (now?.qid === place.qid) {
    sameAsNow++;
    continue;
  }
  moved.push({ name: p.name, from: now?.name ?? 'nowhere', to: place.name, origin });
  if (apply) write.run(place.qid, p.spotify_id);
}

console.log('');
console.log(`${moved.length} artist(s) ${apply ? 'moved' : 'would move'}:`);
for (const m of moved) console.log(`  ${m.name}: ${m.from} -> ${m.to}   ("${m.origin}")`);
console.log('');
console.log(`  ${sameAsNow} already in the right place`);
console.log(`  ${unresolved} had an origin that is not a place on the map`);
console.log(`  ${noOrigin} have no origin field — they keep their birthplace`);
console.log(`  ${noArticle} have no English Wikipedia article`);
if (!apply) console.log('\n(dry run — nothing written)');
