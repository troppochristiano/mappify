/**
 * Resolve the P131 containment chain above every place, into `admin_areas`.
 *
 * `places.parent_qid` answers "what does this nest under in the browse tree",
 * and only accepts settlements: Brooklyn keeps New York City, Atlanta drops
 * Fulton County and stays top-level. That is the right rule for the tree and
 * useless for geography — 462 of 563 places had no parent at all, so Fort Worth
 * and Texas both measured as depth 0 and nothing could tell one sits inside the
 * other.
 *
 * This walks the unfiltered chain instead, counties and states included, and
 * records every hop. "Is A inside B" becomes a walk up the chain and "prefer the
 * more specific place" a depth comparison, which is what unblocks
 * tools/fix-artist-scenes.js.
 *
 * Where the hops go, and why not into `places`:
 *
 *   Everything that renders reads `places` — the browse tree, the globe, the
 *   place picker. Writing ancestors there was tried and reverted: it pushed
 *   Bologna, Montréal, Lyon and four others down a level behind shells like
 *   "Urban agglomeration of Montreal", and offered Texas as a place to pin an
 *   artist to. collapseWrappers() rescued five of the seven and correctly
 *   refused the rest, since Wikidata types Bordeaux Métropole as a city. So the
 *   chain lives in `admin_areas`, which nothing renders, and a run leaves
 *   /api/tree, /api/map and /api/links byte-identical.
 *
 *   node tools/resolve-place-chains.js [--dry-run] [--all] [Q60 Q65 ...]
 *
 * With QIDs, resolves those instead of the place table — the same call the scene
 * pass makes for a place it read out of a Wikipedia category. --all re-resolves
 * chains already on file; by default known nodes are skipped, so a second run
 * costs nothing.
 */
import '../server/env.js';
import { openDbForCli } from '../server/db.js';
import { resolveChains } from '../server/admin-chain.js';
import { buildContainment } from '../server/containment.js';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const force = args.includes('--all');
const explicit = args.filter((a) => /^Q\d+$/.test(a));

const db = openDbForCli();

const seeds = explicit.length
  ? explicit
  : db
      .prepare(`SELECT qid FROM places WHERE qid LIKE 'Q%' ORDER BY qid`)
      .all()
      .map((r) => r.qid);

if (dry) {
  const known = new Set(db.prepare('SELECT qid FROM admin_areas').all().map((r) => r.qid));
  const todo = force ? seeds : seeds.filter((q) => !known.has(q));
  console.log(`${seeds.length} seed(s), ${todo.length} would be fetched:`);
  console.log(`  ${todo.slice(0, 20).join(' ')}${todo.length > 20 ? ' ...' : ''}`);
  console.log('\n(dry run — nothing written)');
  db.close();
  process.exit(0);
}

const res = await resolveChains(db, seeds, { force, log: (m) => console.log(m) });
console.log(`\n${res.nodes} node(s) written, ${res.parents} with a parent.`);

const c = buildContainment(db);
const nameOf = new Map(
  db.prepare('SELECT qid, name FROM admin_areas').all().map((r) => [r.qid, r.name])
);
for (const r of db.prepare('SELECT qid, name FROM places').all()) nameOf.set(r.qid, r.name);

// Places someone in the library is actually from, which is where a wrong chain
// would do damage.
const sample = db
  .prepare(
    `SELECT DISTINCT p.qid FROM places p
      JOIN place_areas pa ON pa.qid = p.qid
      JOIN artists a ON a.mb_begin_area_id = pa.mb_area_id
      LIMIT 10`
  )
  .all();
for (const s of sample) {
  console.log(`  ${c.chain(s.qid).map((q) => nameOf.get(q) ?? q).join(' -> ')}`);
}

const stats = db
  .prepare(
    `SELECT (SELECT count(*) FROM places WHERE qid LIKE 'Q%') places,
            (SELECT count(*) FROM places p WHERE p.qid LIKE 'Q%'
               AND EXISTS (SELECT 1 FROM admin_areas a
                           WHERE a.qid = p.qid AND a.admin_parent_qid IS NOT NULL)) chained,
            (SELECT count(*) FROM admin_areas) nodes`
  )
  .get();
console.log(
  `\nplaces ${stats.places} | on a chain ${stats.chained} | ` +
    `chain nodes ${stats.nodes} | median depth ${c.medianDepth()}`
);
db.close();
