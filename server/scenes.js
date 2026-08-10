/**
 * Place artists by the scene Wikipedia files them under, not their birth record.
 *
 * The infobox pass (tools/fix-artist-origins.js) only helps where an editor
 * filled in an `origin` field, and that field belongs to `Infobox musical
 * artist` — the template bands use. Solo artists usually get `Infobox person`
 * instead, which has no such field: Tupac Shakur's infobox records birth_place
 * and nothing about where he is from. The miss is structural, and it falls
 * hardest on exactly the people whose birthplace is most misleading.
 *
 * Categories do not care which template an article chose. "Rappers from
 * Detroit", "Musicians from Oxnard, California", "Musical groups from Perth" —
 * a role plus a place, which is the claim we actually want.
 *
 * Only music roles count. The same articles carry "Male actors from Manhattan",
 * "Activists from New York City", "Criminals from New York City" — all true, and
 * none of them about where the music started.
 *
 * ## How a birthplace is allowed to lose
 *
 * Two containment drops, applied before any vote is counted, both from
 * server/containment.js:
 *
 *   1. A category naming somewhere that *contains* the birthplace is a vaguer
 *      restatement of what we already have, not evidence of anywhere new.
 *      Manhattan contains 2Pac's East Harlem, so Baltimore stands alone and he
 *      moves. New York City contains Staten Island, so Raekwon stays. Texas
 *      contains Fort Worth; Essex contains Braintree.
 *
 *   2. A category naming the seat of an area just above the birthplace is too
 *      ambiguous to act on: "Musicians from Los Angeles" is written about people
 *      from the county as readily as from the city. That is what keeps Snoop in
 *      Long Beach and YG in Compton even though Los Angeles outvotes them three
 *      to one — containment alone would not, since LA does not contain Long
 *      Beach. Bounded to two levels, or England's P36 would make London
 *      unclaimable for every English artist.
 *
 * What survives is voted on, most-cited first, and a birthplace only loses to
 * something cited strictly more often. Depth is compared along one chain only —
 * Fort Worth against Texas, never Baltimore against Manhattan, which sit in
 * different hierarchies and whose depths mean nothing to each other.
 *
 * ## What it still gets wrong, knowingly
 *
 *   - Wikidata puts London (Q84) beside the boroughs rather than above them, so
 *     nothing derived says Brixton is in London. Bowie moves Brixton -> London,
 *     one level vaguer. No property fixes it — P131 and P150 were both checked.
 *   - Rule 2 costs real moves. Atlanta is the seat of Fulton County, so Outkast
 *     stay in East Point rather than reaching the scene they are.
 *   - A category naming a state beats a wrong city elsewhere: Khalid moves from
 *     Fort Stewart to Texas. Coarse, and truer than where he was.
 */
import { sparql } from './wikidata.js';
import { resolveChains } from './admin-chain.js';
import { buildContainment } from './containment.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Category prefixes that mean "made music here".
 *
 * Anchored at the start so "Rappers from X" counts and "Male actors from X"
 * does not — the whole point is to ignore the other lives a person led.
 */
const MUSIC_ROLE =
  /^(Rappers|Musicians|Singers|Songwriters|Singer-songwriters|Record producers|Musical groups|Bands|Guitarists|Drummers|Bassists|Pianists|Keyboardists|Composers|DJs|Rock musicians|Jazz musicians|Electronic musicians|Hip hop|Hip-hop)/i;

/** Wikimedia asks for a contact address in the User-Agent. */
const userAgent = () =>
  `mappify/0.1 (personal music map; ${process.env.MB_CONTACT ?? 'unknown-contact'})`;

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [opts]
 * @param {number} [opts.limit]   most-played artists first, so a bounded run is the useful one
 * @param {boolean} [opts.apply]  false to decide without writing
 * @param {(name: string) => boolean} [opts.why]  per-artist reasoning, printed through log
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{moved: object[], stats: object}>}
 */
export async function resolveScenes(db, { limit = 2000, apply = true, why = () => false, log = () => {} } = {}) {
  const people = db
    .prepare(
      `SELECT spotify_id, name, mbid, mb_country_iso, mb_begin_area_id FROM artists
        WHERE mbid IS NOT NULL AND mbid <> ''
          AND origin_wiki_qid IS NULL AND origin_override_qid IS NULL
          AND EXISTS (SELECT 1 FROM track_artists ta WHERE ta.artist_id = spotify_id)
        ORDER BY (SELECT count(*) FROM track_artists ta WHERE ta.artist_id = spotify_id) DESC
        LIMIT ?`
    )
    .all(limit);

  const stats = {
    considered: people.length,
    noArticle: 0,
    noMusicCat: 0,
    unresolved: 0,
    onlyBirthplace: 0,
    unbreakable: 0,
    lostBatches: 0,
  };
  if (!people.length) return { moved: [], stats };

  log(`${people.length} artist(s) still on a birthplace or unplaced.`);

  // ---- mbid -> English Wikipedia article -------------------------------------
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
      log(`  ! article lookup failed: ${err.message}`);
    }
  }
  log(`  ${titleOf.size} have an English Wikipedia article.`);

  // ---- article -> categories -------------------------------------------------
  const catsOf = new Map();
  const titles = [...new Set(titleOf.values())];

  /**
   * Wikipedia answers a burst of these with an HTML rate-limit page rather than
   * JSON, which arrives as "Unexpected token 'Y'" — the body starts "You are
   * making too many requests". Twelve of fifty batches died that way on the
   * first full run, and a dead batch takes twenty artists with it: they come out
   * looking like they simply have no music category, indistinguishable from the
   * real thing. So a failure is retried, and what still fails is counted aloud.
   */
  async function fetchCategories(batch) {
    const url =
      'https://en.wikipedia.org/w/api.php?action=query&prop=categories&cllimit=500' +
      '&format=json&redirects=1&titles=' +
      encodeURIComponent(batch.join('|'));

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': userAgent() } });
        const body = await res.text();
        if (!res.ok || !body.startsWith('{')) {
          throw new Error(res.ok ? `not JSON: ${body.slice(0, 40)}` : `HTTP ${res.status}`);
        }
        return JSON.parse(body);
      } catch (err) {
        if (attempt === 4) {
          log(`  ! gave up on a batch of ${batch.length}: ${err.message}`);
          stats.lostBatches++;
          return null;
        }
        await sleep(Math.min(30_000, 2000 * 2 ** attempt));
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
  }
  if (stats.lostBatches) {
    log(
      `  ${stats.lostBatches} batch(es) never came back — up to ${stats.lostBatches * 20} artist(s) ` +
        `are counted as having no category when nobody actually looked. Re-run to pick them up.`
    );
  }

  // ---- places, and how they relate ------------------------------------------
  const byName = new Map();
  const placeByQid = new Map();
  for (const p of db
    .prepare(
      'SELECT qid, name, country_iso, parent_qid FROM places WHERE lat IS NOT NULL AND merged_into IS NULL'
    )
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

  // ---- what each artist's categories claim, before judging any of it --------
  //
  // Gathered in full first because the judgement needs containment, and
  // containment needs every place involved to be on a chain. Asking Wikidata
  // once for the whole set beats a round trip inside the loop.
  const claims = [];
  for (const p of people) {
    const title = titleOf.get(p.mbid);
    if (!title) {
      stats.noArticle++;
      continue;
    }
    const roleCats = (catsOf.get(title) ?? []).filter(
      (k) => / from /.test(k) && MUSIC_ROLE.test(k)
    );
    if (!roleCats.length) {
      stats.noMusicCat++;
      continue;
    }

    // Two roles naming Detroit is stronger evidence than one naming elsewhere.
    const votes = new Map();
    for (const k of roleCats) {
      const hit = resolvePlace(k.split(/ from /)[1], p.mb_country_iso);
      if (!hit) continue;
      votes.set(hit.qid, (votes.get(hit.qid) ?? 0) + 1);
    }
    if (!votes.size) {
      stats.unresolved++;
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
  for (const k of claims) {
    for (const qid of k.votes.keys()) involved.add(qid);
    if (k.birth) involved.add(k.birth);
  }
  const onFile = new Set(db.prepare('SELECT qid FROM admin_areas').all().map((r) => r.qid));
  const unchained = [...involved].filter((q) => !onFile.has(q));
  if (unchained.length) {
    log(`resolving containment for ${unchained.length} place(s) not yet on a chain`);
    await resolveChains(db, unchained);
  }
  const c = buildContainment(db);
  const nameOfPlace = (qid) => placeByQid.get(qid)?.name ?? qid;

  // A place with no chain reads as depth 0, exactly like a country. That is
  // absence of evidence, not evidence of breadth, so a candidate nobody can
  // place in a hierarchy is refused rather than allowed to win on a technicality.
  const chained = (qid) => c.depth(qid) > 0;

  const write = db.prepare('UPDATE artists SET origin_wiki_qid = ? WHERE spotify_id = ?');
  const moved = [];

  for (const { p, roleCats, votes, birth } of claims) {
    const tell = why(p.name) ? (m) => log(`  [${p.name}] ${m}`) : null;
    tell?.(`born ${birth ? nameOfPlace(birth) : 'nowhere known'}`);
    if (tell) {
      for (const [qid, n] of votes) {
        const rel =
          birth && qid === birth
            ? ' — the birthplace itself'
            : !birth
              ? ''
              : c.isInside(birth, qid)
                ? ' — contains the birthplace, dropped'
                : c.isSeatOver(qid, birth)
                  ? ' — seat of an area containing the birthplace, too ambiguous, dropped'
                  : c.isInside(qid, birth)
                    ? ' — inside the birthplace, sharper'
                    : '';
        tell(`  ${nameOfPlace(qid)}: ${n} categor${n === 1 ? 'y' : 'ies'}${rel}`);
      }
    }

    const restatesBirth = (qid) => Boolean(birth) && qid !== birth && c.isInside(birth, qid);
    const ambiguousWith = (qid) => Boolean(birth) && c.isSeatOver(qid, birth);

    const candidates = [...votes.keys()].filter(
      (qid) => !restatesBirth(qid) && !ambiguousWith(qid) && chained(qid)
    );
    if (!candidates.length) {
      tell?.('stays: every category either restates the birthplace or names an unplaceable spot');
      stats.unresolved++;
      continue;
    }

    // Most-cited wins. A tie goes to the more specific place, but only where one
    // contains the other — depths from different hierarchies are not comparable,
    // and treating them as if they were is how a borough would outrank a city.
    candidates.sort(
      (a, b) => votes.get(b) - votes.get(a) || (c.isInside(a, b) ? -1 : c.isInside(b, a) ? 1 : 0)
    );
    const best = candidates[0];

    // Preferring anywhere-but-the-birthplace outright looked right for 2Pac and
    // was wrong far more often. Somewhere *inside* the birthplace is the
    // exception, and an improvement: MusicBrainz says Manhattan, the article
    // says Harlem, and Harlem answers the same question better.
    const sharpensBirth = (qid) => Boolean(birth) && qid !== birth && c.isInside(qid, birth);
    const birthVotes = birth ? votes.get(birth) ?? 0 : 0;
    if (best === birth || (!sharpensBirth(best) && votes.get(best) <= birthVotes)) {
      tell?.(
        `stays: ${nameOfPlace(best)} has ${votes.get(best)} against the birthplace's ${birthVotes}, ` +
          'and a birthplace only loses to strictly more'
      );
      stats.onlyBirthplace++;
      continue;
    }

    const runnerUp = candidates[1];
    if (
      runnerUp !== undefined &&
      votes.get(runnerUp) === votes.get(best) &&
      !c.isInside(best, runnerUp) &&
      !c.isInside(runnerUp, best)
    ) {
      tell?.(`stays: ${nameOfPlace(best)} and ${nameOfPlace(runnerUp)} tie and neither contains the other`);
      stats.unbreakable++;
      continue;
    }

    tell?.(`moves to ${nameOfPlace(best)}`);
    moved.push({
      spotifyId: p.spotify_id,
      name: p.name,
      qid: best,
      from: birth ? nameOfPlace(birth) : 'nowhere',
      to: nameOfPlace(best),
      because: roleCats.filter(
        (k) => resolvePlace(k.split(/ from /)[1], p.mb_country_iso)?.qid === best
      ),
    });
    if (apply) write.run(best, p.spotify_id);
  }

  return { moved, stats };
}
