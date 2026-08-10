// Resolves P131 containment chains into `admin_areas`, for any Wikidata QID.
//
// Split out of the CLI tool because the callers that need containment most do
// not have their subjects in `places` yet: the scene pass reads a place out of a
// Wikipedia category — "Rappers from Compton" — and has to ask whether it sits
// inside the birthplace it would be overturning, before anything has ever made
// it a place. Seeding only from existing rows would answer "unknown" for exactly
// the cases the question exists for.
//
// Nothing here touches `places`, on purpose. See server/db.js on admin_areas.

import { sparql } from './wikidata.js';

const BATCH = 90;
const MAX_DEPTH = 8; // Kensington -> ... -> United Kingdom is five; eight is slack.

const qidOf = (u) => (u ? u.split('/').pop() : null);
const num = (q) => Number(q.slice(1)) || Number.MAX_SAFE_INTEGER;

/**
 * Walk up from `qids` until every chain closes, and write what it finds.
 *
 * Already-resolved nodes are skipped unless `force`, so calling this per artist
 * costs one round trip the first time a place is seen and nothing after that.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string[]} qids
 * @returns {Promise<{nodes:number, parents:number, fetched:number}>}
 */
export async function resolveChains(db, qids, { force = false, log = () => {} } = {}) {
  const seeds = [...new Set(qids.filter((q) => /^Q\d+$/.test(q)))];
  if (!seeds.length) return { nodes: 0, parents: 0, fetched: 0 };

  const done = force
    ? new Set()
    : new Set(db.prepare('SELECT qid FROM admin_areas').all().map((r) => r.qid));

  const edges = new Map(); // qid -> Set(parent)
  const names = new Map();
  const capitals = new Map(); // qid -> the seat that administers it, P36
  const visited = new Set();
  let fetched = 0;

  let frontier = seeds.filter((q) => !done.has(q));
  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
    const todo = frontier.filter((q) => !visited.has(q));
    todo.forEach((q) => visited.add(q));
    const next = new Set();
    if (!todo.length) break;

    log(`hop ${depth + 1}: ${todo.length} place(s)`);
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      const V = batch.map((q) => `wd:${q}`).join(' ');

      // Every pattern hangs off the bound ?place. An unbound subject here would
      // match every P131 statement in Wikidata — the trap that once returned a
      // 512 MB body from the artist query.
      const q = `SELECT ?place ?placeLabel ?parent ?capital WHERE {
        VALUES ?place { ${V} }
        OPTIONAL { ?place wdt:P131 ?parent }
        OPTIONAL { ?place wdt:P36 ?capital }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
      }`;

      let json;
      try {
        json = await sparql(q);
        fetched += batch.length;
      } catch (err) {
        log(`  ! batch ${Math.floor(i / BATCH) + 1} failed: ${err.message}`);
        continue;
      }

      for (const b of json.results.bindings) {
        const place = qidOf(b.place?.value);
        if (!place) continue;
        if (!names.has(place)) names.set(place, b.placeLabel?.value ?? place);
        // P36 is single-valued in practice; first binding wins, as elsewhere.
        const cap = qidOf(b.capital?.value);
        if (cap && !capitals.has(place)) capitals.set(place, cap);
        const parent = qidOf(b.parent?.value);
        // "Inside itself" is a real statement on a few Wikidata items, and would
        // make the walk below never terminate.
        if (!parent || parent === place) continue;
        if (!edges.has(place)) edges.set(place, new Set());
        edges.get(place).add(parent);
        next.add(parent);
      }
      log(
        `  batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(todo.length / BATCH)}: ${json.results.bindings.length} bindings`
      );
    }
    // An ancestor already on file still ends the walk: its own chain is stored.
    frontier = [...next].filter((q) => !visited.has(q) && !done.has(q));
  }

  const chosen = pickParents(edges);

  const upsert = db.prepare(`
    INSERT INTO admin_areas (qid, name, admin_parent_qid, capital_qid, resolved_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(qid) DO UPDATE SET
      name             = COALESCE(excluded.name, admin_areas.name),
      admin_parent_qid = excluded.admin_parent_qid,
      capital_qid      = COALESCE(excluded.capital_qid, admin_areas.capital_qid),
      resolved_at      = excluded.resolved_at
  `);
  // The same fact mirrored onto places where a row exists, because the shared
  // index carries that column too and containment reads either source.
  const mirror = db.prepare(
    'UPDATE places SET admin_parent_qid = ? WHERE qid = ? AND admin_parent_qid IS NULL'
  );

  const stamp = new Date().toISOString();
  db.exec('BEGIN');
  for (const qid of visited) {
    upsert.run(qid, names.get(qid) ?? null, chosen.get(qid) ?? null, capitals.get(qid) ?? null, stamp);
    if (chosen.has(qid)) mirror.run(chosen.get(qid), qid);
  }
  db.exec('COMMIT');

  return { nodes: visited.size, parents: chosen.size, fetched, names, chosen };
}

/**
 * One parent per node, because the column holds one.
 *
 * Where P131 gives several, the nearest wins: Atlanta is in Fulton County and in
 * Georgia, and Georgia is reachable from Fulton, so Fulton is the tighter fact
 * and the chain still passes through Georgia one hop later. Where neither
 * candidate contains the other — Atlanta's Fulton and DeKalb — the tie goes to
 * the lower QID, which is arbitrary but stable across runs, and both roads lead
 * to Georgia regardless.
 */
function pickParents(edges) {
  const reaches = (from, target, seen = new Set()) => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    for (const p of edges.get(from) ?? []) if (reaches(p, target, seen)) return true;
    return false;
  };

  const chosen = new Map();
  for (const [place, parents] of edges) {
    const list = [...parents];
    const nearest = list.filter((p) => !list.some((o) => o !== p && reaches(o, p)));
    const pool = nearest.length ? nearest : list;
    chosen.set(place, pool.sort((a, b) => num(a) - num(b))[0]);
  }
  return chosen;
}
