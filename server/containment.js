// "Is A inside B", and how specific a place is — read off the admin_parent_qid
// chain that tools/resolve-place-chains.js fills in.
//
// This is the thing tools/fix-artist-scenes.js was blocked on. A Wikipedia
// category naming Texas cannot be allowed to overturn a birthplace in Fort
// Worth, and a category naming Baltimore has to be allowed to overturn one in
// Manhattan. Both fall out of the same rule once containment is computable:
// prefer the more specific place, and only overturn on a place the current one
// does not already contain.
//
// Reads admin_parent_qid and never parent_qid. The two are different questions:
// parent_qid is what the browse tree nests under and holds settlements only, so
// walking it would put Fort Worth and Texas at the same depth — exactly the
// state that made the scene pass unsafe to apply.

const MAX_HOPS = 12; // the deepest real chain is ~6; this only bounds a cycle.

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{
 *   chain(qid: string): string[],
 *   isInside(a: string, b: string): boolean,
 *   depth(qid: string): number,
 *   medianDepth(): number,
 * }}
 */
export function buildContainment(db) {
  // Two sources for the same fact. `places.admin_parent_qid` is the single hop
  // the shared index carries, so a fresh install has something before anyone
  // runs the chain resolver; `admin_areas` is the full walk, and includes the
  // counties and regions that are not places at all. The full walk wins where
  // both know a place.
  const parent = new Map(
    db
      .prepare('SELECT qid, admin_parent_qid FROM places WHERE admin_parent_qid IS NOT NULL')
      .all()
      .map((r) => [r.qid, r.admin_parent_qid])
  );
  for (const r of db
    .prepare('SELECT qid, admin_parent_qid FROM admin_areas WHERE admin_parent_qid IS NOT NULL')
    .all()) {
    parent.set(r.qid, r.admin_parent_qid);
  }
  // P36. `places.capital_qid` is filled by server/places.js, `admin_areas` by the
  // chain resolver, and only the second knows about counties.
  const capital = new Map();
  for (const r of db.prepare('SELECT qid, capital_qid FROM places WHERE capital_qid IS NOT NULL').all()) {
    capital.set(r.qid, r.capital_qid);
  }
  for (const r of db
    .prepare('SELECT qid, capital_qid FROM admin_areas WHERE capital_qid IS NOT NULL')
    .all()) {
    capital.set(r.qid, r.capital_qid);
  }

  const cache = new Map();

  /** The place itself, then every ancestor, nearest first. */
  function chain(qid) {
    if (!qid) return [];
    const hit = cache.get(qid);
    if (hit) return hit;
    const out = [qid];
    const seen = new Set([qid]);
    for (let cur = parent.get(qid); cur && !seen.has(cur) && out.length < MAX_HOPS; cur = parent.get(cur)) {
      seen.add(cur);
      out.push(cur);
    }
    cache.set(qid, out);
    return out;
  }

  return {
    chain,
    /** True when a is b, or sits anywhere below it. */
    isInside: (a, b) => Boolean(a && b) && chain(a).includes(b),
    /**
     * True when `seat` administers something close above `place` — Los Angeles
     * for anywhere in Los Angeles County.
     *
     * This is an ambiguity test, not a containment one. "Musicians from Los
     * Angeles" is written about people from the county as readily as from the
     * city, so it is not a claim about the city specifically and must not
     * overturn a precise birthplace inside that county. Long Beach and Compton
     * both survive on it.
     *
     * Bounded to the two nearest levels, and that bound is load-bearing.
     * England's P36 is London and France's is Paris, so an unbounded walk makes
     * every national capital permanently unclaimable: an artist born in
     * Manchester could never move to the London scene, and Nico could never
     * move from Köln to Berlin. Two levels is the range where "from X" is
     * genuinely ambiguous between a city and the district around it.
     *
     * The cost is real and accepted: Atlanta is the seat of Fulton County, so
     * an artist born in East Point stays in East Point rather than moving to
     * the scene next door.
     */
    isSeatOver(seat, place, hops = 2) {
      if (!seat || !place || seat === place) return false;
      // slice(1) — the place itself is not "above" it, and a seat inside the
      // birthplace is a sharpening rather than an ambiguity.
      return chain(place)
        .slice(1, 1 + hops)
        .some((a) => capital.get(a) === seat);
    },
    /**
     * Hops to the top of the known chain — a usable stand-in for "how specific".
     * A place with no chain is 0, which reads the same as a country, so a caller
     * comparing two places must treat an unresolved one as no evidence rather
     * than as evidence of breadth.
     */
    depth: (qid) => chain(qid).length - 1,
    medianDepth() {
      const all = [...parent.keys()].map((q) => chain(q).length - 1).sort((a, b) => a - b);
      return all.length ? all[Math.floor(all.length / 2)] : 0;
    },
  };
}
