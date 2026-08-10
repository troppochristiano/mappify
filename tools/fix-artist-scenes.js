/**
 * Place artists by the scene Wikipedia files them under, not their birth record.
 *
 * The infobox pass (fix-artist-origins.js) only helps where an editor filled in
 * an `origin` field, and that field belongs to `Infobox musical artist` — the
 * template bands use. Solo artists usually get `Infobox person` instead, which
 * has no such field: Tupac Shakur's infobox records birth_place and nothing
 * about where he is from. So the miss is structural, and it falls hardest on
 * exactly the people whose birthplace is most misleading.
 *
 * Categories do not care which template an article chose. "Rappers from
 * Detroit", "Musicians from Oxnard, California", "Musical groups from Perth" —
 * a role plus a place, which is the claim we actually want. Measured over 150
 * people still sitting on a birthplace: 54% carry at least one, and 31% resolve
 * to a single place on the map.
 *
 * Only music roles count. The same articles carry "Male actors from Manhattan",
 * "Activists from New York City", "Criminals from New York City" — all true, and
 * none of them about where the music started.
 *
 * What made this unsafe, and what changed.
 *
 * The two failure modes used to pull against each other:
 *
 *   - Loosen it, and a birthplace that *is* the scene gets overturned by one
 *     stray category: Snoop Dogg out of Long Beach, YG out of Compton, Raekwon
 *     off Staten Island, all to "Los Angeles" or "New York City".
 *   - Tighten it so a birthplace only loses to strictly better evidence, and the
 *     cases this pass exists for disappear: 2Pac has one category for Baltimore
 *     and one for Manhattan, and Manhattan looked like just another rival place,
 *     so the tie went to the birthplace and he stayed put.
 *
 * Containment collapses both into two drops, applied before anything is counted.
 * Both come from the chain in server/containment.js, filled by
 * tools/resolve-place-chains.js.
 *
 *   1. A category naming somewhere that *contains* the birthplace is a vaguer
 *      restatement of what we already have, not evidence of anywhere new.
 *      Manhattan contains 2Pac's East Harlem, so Baltimore stands alone and he
 *      moves. New York City contains Staten Island, so Raekwon stays. Texas
 *      contains Fort Worth and Essex contains Braintree, which is the plain
 *      vagueness the old depth floor was there for.
 *
 *   2. A category naming the seat of an area just above the birthplace is too
 *      ambiguous to act on: "Musicians from Los Angeles" is written about people
 *      from the county as readily as from the city. That is what keeps Snoop in
 *      Long Beach and YG in Compton even though Los Angeles outvotes them three
 *      to one — containment alone would not, since LA does not contain Long
 *      Beach. Bounded to two levels, or England's P36 would make London
 *      unclaimable for every English artist.
 *
 * Depth is only ever compared along one chain — Fort Worth against Texas, never
 * Baltimore against Manhattan, which sit in different hierarchies and whose
 * depths mean nothing to each other.
 *
 * What it still gets wrong, knowingly:
 *
 *   - Wikidata puts London (Q84) beside the boroughs rather than above them, so
 *     nothing derived says Brixton is in London. Bowie moves Brixton -> London,
 *     one level vaguer. No property fixes it — P131 and P150 were both checked.
 *   - Rule 2 costs real moves. Atlanta is the seat of Fulton County, so Outkast
 *     stay in East Point rather than reaching the scene they are.
 *   - A category naming a state beats a wrong city elsewhere: Khalid moves from
 *     Fort Stewart to Texas. Coarse, and truer than where he was.
 *
 *   node tools/fix-artist-scenes.js [--dry-run] [--limit N] [--why "name,name"]
 *
 * --why prints the full reasoning for those artists, which is how the cases
 * above are checked rather than asserted. Writes the same column as the infobox
 * pass, so `fix-artist-origins.js --revert` clears both, and a place you set by
 * hand still outranks it.
 */
import '../server/env.js';
import { openDb } from '../server/db.js';
import { sparql } from '../server/wikidata.js';
import { resolveChains } from '../server/admin-chain.js';
import { buildContainment } from '../server/containment.js';

const db = openDb();
const args = process.argv.slice(2);
const apply = !args.includes('--dry-run');
const li = args.indexOf('--limit');
const LIMIT = li >= 0 ? Number(args[li + 1]) : 2000;
// --why "Snoop Dogg,2Pac" prints the full reasoning for those artists. The
// safety of this pass rests on a handful of specific cases going a specific way,
// and "they are not in the moved list" is not the same as "the rule held".
const wi = args.indexOf('--why');
const WHY = new Set(
  (wi >= 0 ? (args[wi + 1] ?? '') : '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
);

/**
 * Category prefixes that mean "made music here".
 *
 * Anchored at the start so "Rappers from X" counts and "Male actors from X"
 * does not — the whole point is to ignore the other lives a person led.
 */
const MUSIC_ROLE =
  /^(Rappers|Musicians|Singers|Songwriters|Singer-songwriters|Record producers|Musical groups|Bands|Guitarists|Drummers|Bassists|Pianists|Keyboardists|Composers|DJs|Rock musicians|Jazz musicians|Electronic musicians|Hip hop|Hip-hop)/i;

// Artists the infobox pass could not place, and that you have not pinned.
const people = db
  .prepare(
    `SELECT spotify_id, name, mbid, mb_country_iso, mb_begin_area_id FROM artists
      WHERE mbid IS NOT NULL AND mbid <> ''
        AND origin_wiki_qid IS NULL AND origin_override_qid IS NULL
        AND EXISTS (SELECT 1 FROM track_artists ta WHERE ta.artist_id = spotify_id)
      ORDER BY (SELECT count(*) FROM track_artists ta WHERE ta.artist_id = spotify_id) DESC
      LIMIT ?`
  )
  .all(LIMIT);

console.log(`${people.length} artist(s) still on a birthplace or unplaced.`);

// ---- mbid -> English Wikipedia article ---------------------------------------
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

// ---- article -> categories ---------------------------------------------------
const catsOf = new Map();
const titles = [...new Set(titleOf.values())];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wikipedia answers a burst of these with an HTML rate-limit page rather than
 * JSON, which arrives as "Unexpected token 'Y'" — the body starts "You are
 * making too many requests". Twelve of fifty batches died that way on the first
 * full run, and a batch that dies takes twenty artists with it: they come out
 * looking like they simply have no music category, which is indistinguishable
 * from the real thing in the summary. So a failure has to be retried, and what
 * still fails has to be counted out loud.
 *
 * The contact address is Wikimedia's stated requirement for a User-Agent, and
 * MB_CONTACT is already set for MusicBrainz.
 */
const UA = `mappify/0.1 (personal music map; ${process.env.MB_CONTACT ?? 'unknown-contact'})`;
let lostBatches = 0;

async function fetchCategories(batch) {
  const url =
    'https://en.wikipedia.org/w/api.php?action=query&prop=categories&cllimit=500' +
    '&format=json&redirects=1&titles=' +
    encodeURIComponent(batch.join('|'));

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      const body = await res.text();
      if (!res.ok || !body.startsWith('{')) {
        throw new Error(res.ok ? `not JSON: ${body.slice(0, 40)}` : `HTTP ${res.status}`);
      }
      return JSON.parse(body);
    } catch (err) {
      const backoff = Math.min(30_000, 2000 * 2 ** attempt);
      if (attempt === 4) {
        console.log(`\n  ! gave up on a batch of ${batch.length}: ${err.message}`);
        lostBatches++;
        return null;
      }
      await sleep(backoff);
    }
  }
  return null;
}

for (let i = 0; i < titles.length; i += 20) {
  const d = await fetchCategories(titles.slice(i, i + 20));
  if (d?.query) {
    for (const p of Object.values(d.query.pages)) {
      catsOf.set(p.title, (p.categories ?? []).map((c) => c.title.replace('Category:', '')));
    }
    for (const n of [...(d.query.normalized ?? []), ...(d.query.redirects ?? [])]) {
      if (catsOf.has(n.to)) catsOf.set(n.from, catsOf.get(n.to));
    }
  }
  process.stdout.write(`\r  fetched ${Math.min(i + 20, titles.length)}/${titles.length} articles`);
}
console.log('');
if (lostBatches) {
  console.log(
    `  ${lostBatches} batch(es) never came back — up to ${lostBatches * 20} artist(s) below are\n` +
      `  counted as having no category when nobody actually looked. Re-run to pick them up.`
  );
}

// ---- places, and how they relate --------------------------------------------
const byName = new Map();
const placeByQid = new Map();
for (const p of db
  .prepare('SELECT qid, name, country_iso, parent_qid FROM places WHERE lat IS NOT NULL AND merged_into IS NULL')
  .all()) {
  placeByQid.set(p.qid, p);
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

/** Same rules as the infobox pass: first segment only, never a country. */
function resolvePlace(raw, iso) {
  const first = raw.replace(/^the\s+/i, '').split(',')[0].trim();
  if (!first) return null;
  const hits = byName.get(first.toLowerCase()) ?? [];
  if (!hits.length) return null;
  let pick = hits[0];
  if (hits.length > 1) {
    const same = hits.filter((h) => h.country_iso && h.country_iso === iso);
    if (same.length !== 1) return null;
    pick = same[0];
  }
  if (pick.country_iso && iso && pick.country_iso !== iso) return null;
  if (regionName(pick.country_iso) === pick.name) return null;
  return pick;
}

const birthPlaceOf = db.prepare(
  `SELECT COALESCE(p.merged_into, p.qid) qid FROM place_areas pa
     JOIN places p ON p.qid = pa.qid WHERE pa.mb_area_id = ?`
);

const write = db.prepare('UPDATE artists SET origin_wiki_qid = ? WHERE spotify_id = ?');
const moved = [];
let noArticle = 0, noMusicCat = 0, unresolved = 0, onlyBirthplace = 0, unbreakable = 0;

// ---- what each artist's categories claim, before judging any of it ----------
//
// Gathered in full first because the judgement needs containment, and
// containment needs every place involved to be on a chain. Asking Wikidata once
// for the whole set beats a round trip inside the loop.
const claims = [];
for (const p of people) {
  const title = titleOf.get(p.mbid);
  if (!title) {
    noArticle++;
    continue;
  }
  const roleCats = (catsOf.get(title) ?? []).filter(
    (c) => / from /.test(c) && MUSIC_ROLE.test(c)
  );
  if (!roleCats.length) {
    noMusicCat++;
    continue;
  }

  // Count how many music categories point at each place: two roles naming
  // Detroit is stronger evidence than one naming somewhere else.
  const votes = new Map();
  for (const c of roleCats) {
    const hit = resolvePlace(c.split(/ from /)[1], p.mb_country_iso);
    if (!hit) continue;
    votes.set(hit.qid, (votes.get(hit.qid) ?? 0) + 1);
  }
  if (!votes.size) {
    unresolved++;
    continue;
  }

  claims.push({
    p,
    roleCats,
    votes,
    birth: p.mb_begin_area_id ? birthPlaceOf.get(p.mb_begin_area_id)?.qid ?? null : null,
  });
}

const involved = new Set();
for (const c of claims) {
  for (const qid of c.votes.keys()) involved.add(qid);
  if (c.birth) involved.add(c.birth);
}
const onFile = new Set(db.prepare('SELECT qid FROM admin_areas').all().map((r) => r.qid));
const unchained = [...involved].filter((q) => !onFile.has(q));
if (unchained.length) {
  console.log(`resolving containment for ${unchained.length} place(s) not yet on a chain`);
  await resolveChains(db, unchained, { log: () => {} });
}
const c = buildContainment(db);

// A place with no chain reads as depth 0, exactly like a country. That is
// absence of evidence, not evidence of breadth, so a candidate nobody can place
// in a hierarchy is refused rather than allowed to win on a technicality.
const chained = (qid) => c.depth(qid) > 0;

const nameOfPlace = (qid) => placeByQid.get(qid)?.name ?? qid;

for (const { p, roleCats, votes, birth } of claims) {
  const why = WHY.has(p.name.toLowerCase()) ? (m) => console.log(`  [${p.name}] ${m}`) : null;
  why?.(`born ${birth ? nameOfPlace(birth) : 'nowhere known'}`);
  if (why) {
    for (const [qid, n] of votes) {
      const rel = !birth || qid === birth
        ? birth && qid === birth
          ? ' — the birthplace itself'
          : ''
        : c.isInside(birth, qid)
          ? ' — contains the birthplace, dropped'
          : c.isSeatOver(qid, birth)
            ? ' — seat of an area containing the birthplace, too ambiguous, dropped'
            : c.isInside(qid, birth)
              ? ' — inside the birthplace, sharper'
              : '';
      why(`  ${nameOfPlace(qid)}: ${n} categor${n === 1 ? 'y' : 'ies'}${rel}`);
    }
  }

  // A category naming somewhere that *contains* the birthplace is a vaguer
  // restatement of what we already have, never a new claim. This is the whole
  // reason the pass was blocked: it is what makes Manhattan not a rival to
  // 2Pac's East Harlem, and "Rappers from New York City" not a reason to move
  // Raekwon off Staten Island — while leaving Snoop's Los Angeles standing,
  // since it does not contain Long Beach and so is a genuine rival.
  //
  // It also covers the plain vagueness cases the old depth floor was there for:
  // Texas contains Fort Worth, Essex contains Braintree.
  const restatesBirth = (qid) => Boolean(birth) && qid !== birth && c.isInside(birth, qid);

  // The same vagueness one step sideways. "Musicians from Los Angeles" is
  // written about people from the county as readily as from the city, so it is
  // not a claim about the city specifically and cannot overturn a birthplace
  // inside that county — which is what keeps Snoop Dogg in Long Beach and YG in
  // Compton even though Los Angeles outvotes them three to one. See
  // isSeatOver() for the cost: Outkast stay in East Point rather than moving to
  // Atlanta, the seat of the county they were born in.
  const ambiguousWith = (qid) => Boolean(birth) && c.isSeatOver(qid, birth);

  let candidates = [...votes.keys()].filter(
    (qid) => !restatesBirth(qid) && !ambiguousWith(qid) && chained(qid)
  );
  if (!candidates.length) {
    why?.('stays: every category either restates the birthplace or names an unplaceable spot');
    unresolved++;
    continue;
  }

  // Most-cited wins. A tie goes to the more specific place, but only where one
  // contains the other — depths from different hierarchies are not comparable,
  // and treating them as if they were is how a borough would outrank a city.
  candidates.sort(
    (a, b) => votes.get(b) - votes.get(a) || (c.isInside(a, b) ? -1 : c.isInside(b, a) ? 1 : 0)
  );
  const best = candidates[0];

  // The birthplace only loses when the evidence actually points elsewhere.
  //
  // Preferring anywhere-but-the-birthplace outright looked right for 2Pac and
  // was wrong far more often: Snoop Dogg was born in Long Beach and *is* Long
  // Beach, YG is Compton, Raekwon is Staten Island — and the rule shoved all
  // three out to the bigger city next door on a single stray category. So a
  // birthplace is only overturned by a place cited strictly more often.
  //
  // Somewhere *inside* the birthplace is the exception, and an improvement:
  // MusicBrainz says Manhattan, the article says Harlem, and Harlem is the
  // better answer to the same question rather than a competing one.
  const sharpensBirth = (qid) => Boolean(birth) && qid !== birth && c.isInside(qid, birth);
  const birthVotes = birth ? votes.get(birth) ?? 0 : 0;
  if (best === birth || (!sharpensBirth(best) && votes.get(best) <= birthVotes)) {
    why?.(
      `stays: ${nameOfPlace(best)} has ${votes.get(best)} against the birthplace's ${birthVotes}, ` +
        'and a birthplace only loses to strictly more'
    );
    onlyBirthplace++;
    continue;
  }

  const runnerUp = candidates[1];
  const tied =
    runnerUp !== undefined &&
    votes.get(runnerUp) === votes.get(best) &&
    !c.isInside(best, runnerUp) &&
    !c.isInside(runnerUp, best);
  if (tied) {
    why?.(`stays: ${nameOfPlace(best)} and ${nameOfPlace(runnerUp)} tie and neither contains the other`);
    unbreakable++;
    continue;
  }

  moved.push({
    name: p.name,
    from: birth ? placeByQid.get(birth)?.name ?? 'elsewhere' : 'nowhere',
    to: placeByQid.get(best).name,
    why: roleCats.filter((k) => resolvePlace(k.split(/ from /)[1], p.mb_country_iso)?.qid === best),
  });
  why?.(`moves to ${nameOfPlace(best)}`);
  if (apply) write.run(best, p.spotify_id);
}

console.log('');
console.log(`${moved.length} artist(s) ${apply ? 'moved' : 'would move'}:`);
for (const m of moved) console.log(`  ${m.name}: ${m.from} -> ${m.to}   [${m.why[0]}]`);
console.log('');
console.log(`  ${onlyBirthplace} named only their birthplace again`);
console.log(`  ${unbreakable} tied with no way to choose`);
console.log(`  ${unresolved} named places not on the map`);
console.log(`  ${noMusicCat} have no music "from" category`);
console.log(`  ${noArticle} have no English Wikipedia article`);
if (!apply) console.log('\n(dry run — nothing written)');
