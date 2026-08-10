/**
 * Re-home places that came back from Wikidata with no parent at all.
 *
 * A parent is only kept when it is itself a human settlement, which is what
 * separates "Brooklyn -> New York City" from "Atlanta -> Fulton County". But the
 * test is applied to the *immediate* P131 parent, and a lot of places sit inside
 * an administrative district first: Chiswick's parent is the London Borough of
 * Hounslow, Brixton's is the London Borough of Lambeth. Neither is a settlement,
 * so both were dropped and the districts floated up as if they were independent
 * towns beside London itself.
 *
 * This keeps the settlement rule and only changes how far it looks: walk two and
 * three hops up the containment chain and take the nearest settlement found.
 * Chiswick reaches Greater London that way; Atlanta still reaches nothing, since
 * county, state and country are not settlements either.
 *
 * Only ancestors already in `places` are attached, so this never invents a node
 * the tree has no other reason to know about. Run: node tools/fix-place-parents.js
 */
import '../server/env.js';
import { openDb } from '../server/db.js';
import { sparql } from '../server/wikidata.js';

const BATCH = 90;
const db = openDb();
const apply = !process.argv.includes('--dry-run');

const orphans = db
  .prepare(
    `SELECT qid, name FROM places
      WHERE parent_qid IS NULL AND merged_into IS NULL AND qid LIKE 'Q%'
      ORDER BY qid`
  )
  .all();

const known = new Set(db.prepare('SELECT qid FROM places').all().map((r) => r.qid));
const nameOf = new Map(db.prepare('SELECT qid, name FROM places').all().map((r) => [r.qid, r.name]));

console.log(`${orphans.length} place(s) with no parent. Looking two and three hops up.`);

const setParent = db.prepare('UPDATE places SET parent_qid = ? WHERE qid = ?');
const found = [];

for (let i = 0; i < orphans.length; i += BATCH) {
  const batch = orphans.slice(i, i + BATCH);
  const V = batch.map((p) => `wd:${p.qid}`).join(' ');

  // Every pattern hangs off a bound subject — an unbound one here would match
  // every P131 statement in Wikidata and blow the response up.
  const q = `SELECT ?place ?p2 ?p3 WHERE {
    VALUES ?place { ${V} }
    ?place wdt:P131 ?mid .
    OPTIONAL {
      ?mid wdt:P131 ?p2 .
      FILTER EXISTS { ?p2 wdt:P31/wdt:P279* wd:Q486972 }
    }
    OPTIONAL {
      ?mid wdt:P131 ?m2 .
      ?m2 wdt:P131 ?p3 .
      FILTER EXISTS { ?p3 wdt:P31/wdt:P279* wd:Q486972 }
    }
  }`;

  let json;
  try {
    json = await sparql(q);
  } catch (err) {
    console.log(`  ! batch ${Math.floor(i / BATCH) + 1} failed: ${err.message}`);
    continue;
  }

  const qid = (u) => (u ? u.split('/').pop() : null);
  const best = new Map();
  for (const b of json.results.bindings) {
    const place = qid(b.place?.value);
    if (!place || best.has(place)) continue;
    // Two hops beats three: the nearest settlement that contains it wins.
    const parent = qid(b.p2?.value) ?? qid(b.p3?.value);
    if (parent && parent !== place && known.has(parent)) best.set(place, parent);
  }

  for (const [child, parent] of best) {
    found.push({ child, parent });
    if (apply) setParent.run(parent, child);
  }
  console.log(
    `  batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(orphans.length / BATCH)}: ${best.size} re-homed`
  );
}

console.log(`\n${found.length} place(s) ${apply ? 'given' : 'would get'} a parent:`);
for (const f of found.slice(0, 25)) {
  console.log(`  ${nameOf.get(f.child)} -> ${nameOf.get(f.parent)}`);
}
if (found.length > 25) console.log(`  ...and ${found.length - 25} more`);
if (!apply) console.log('\n(dry run — nothing written)');
