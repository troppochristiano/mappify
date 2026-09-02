// How alike two libraries are, as arithmetic.
//
// Its own file, with no database in it and no imports at all, for the same
// reason filters.js is its own file: this is the one piece of the app that makes
// a *claim* rather than fetching a fact. "You are a 62% match" is a sentence
// somebody will repeat to a friend, and it has to be defensible when they ask
// where the number came from. Pure functions over plain arrays can be asserted
// on directly, with two literals and no server.
//
// One thing to keep in mind throughout: Mappify has no listening history. There
// are no play counts anywhere in the schema. Every count here is *tracks in the
// library* — so nothing in this file is named `plays` or `listens`, and nothing
// downstream may present it that way.

/**
 * How a track count is weighted before comparison.
 *
 * Sub-linear, so a saved discography leads without deciding the answer alone.
 * With raw counts, an artist you have 300 tracks of contributes 90,000 to the
 * squared norm while a thousand artists at one to five tracks contribute maybe
 * 20,000 between them — the cosine then effectively asks a single question, "is
 * your favourite their favourite", and the score swings thirty points on a coin
 * flip. This library holds 385 saved albums, so that tail is real.
 *
 * Under a square root a 100x count ratio becomes a 10x weight ratio: the big
 * artist still leads, but a hundred quiet agreements can outvote it. This is the
 * same damping BM25 applies to term frequency, for the same reason.
 *
 * Log was the other candidate and flattens too hard at the top — it would make
 * three hundred tracks worth only about four of an artist you have three of,
 * which is not how anyone experiences their own taste. Kept as a named constant
 * so the choice can be swapped and re-measured rather than hunted for.
 */
const DAMP = Math.sqrt;

/** Below this many artists on either side the score is noise. See `compareLibraries`. */
const MIN_ARTISTS_FOR_CONFIDENCE = 25;

/**
 * Rows to a sparse vector, summing duplicates.
 *
 * Duplicates are summed rather than overwritten because an import that collapsed
 * two qids through `merged_into` legitimately produces two rows for one place,
 * and dropping one of them would quietly understate that city.
 */
export function toVector(rows, idKey = 'id', countKey = 'tracks') {
  const v = new Map();
  for (const r of rows ?? []) {
    const id = r?.[idKey];
    if (id == null || id === '') continue;
    const n = Number(r[countKey]);
    if (!Number.isFinite(n) || n <= 0) continue;
    v.set(id, (v.get(id) ?? 0) + n);
  }
  return v;
}

/**
 * The angle between two libraries, in [0, 1].
 *
 * Cosine rather than Jaccard, and the reason is not taste. Cosine is invariant
 * to scaling either side, which *is* the "6,000 tracks against 400" problem
 * solved by construction rather than by a fudge factor. Jaccard cannot do that
 * job at all: a 400-artist library that is a perfect subset of a 6,000-artist
 * one scores 400/6000 = 0.067, and no wording rescues a measure that is
 * mathematically unable to say "you are entirely contained in me".
 *
 * With DAMP = sqrt this is exactly the Bhattacharyya coefficient between the two
 * libraries read as distributions — worth knowing mainly because it means the
 * measure has a name, a fixed range and a proof of symmetry, rather than being
 * something invented here.
 */
export function cosine(a, b, damp = DAMP) {
  if (!a?.size || !b?.size) return 0;

  // Walk the smaller side and probe the larger. Same answer either way, but the
  // work is bounded by the smaller library rather than by the bigger one.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [id, n] of small) {
    const m = large.get(id);
    if (m === undefined) continue;
    dot += damp(n) * damp(m);
  }
  if (dot === 0) return 0;

  let na = 0;
  for (const n of a.values()) na += damp(n) ** 2;
  let nb = 0;
  for (const n of b.values()) nb += damp(n) ** 2;

  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (!denom) return 0;
  // Clamped because floating point hands back 1.0000000000000002 for a library
  // compared with itself, and a "100.00000001% match" is a bug report.
  return Math.min(1, dot / denom);
}

/**
 * What both sides have, densest agreement first.
 *
 * Ranked by `min(mine, theirs)`, never by the sum. An artist you have ninety
 * tracks of and they have one of is not a shared favourite — it is your
 * favourite, which they have heard of. The smaller of the two counts is the
 * amount actually agreed on, and sorting by it is what stops this list from
 * being your own top ten reprinted on every friend's page.
 */
export function intersect(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const flipped = small !== a;
  const out = [];
  for (const [id, n] of small) {
    const m = large.get(id);
    if (m === undefined) continue;
    out.push({ id, mine: flipped ? m : n, theirs: flipped ? n : m });
  }
  out.sort(
    (x, y) =>
      Math.min(y.mine, y.theirs) - Math.min(x.mine, x.theirs) ||
      y.mine + y.theirs - (x.mine + x.theirs)
  );
  return out;
}

/**
 * How much of the smaller library the overlap covers.
 *
 * `min` as the denominator, so the figure does not pick a side: "42% of the
 * smaller collection is in both" is one statement about the pair, where "42% of
 * theirs is in yours" and "3% of yours is in theirs" are two statements about
 * the same overlap that invite the reader to feel like the loser.
 */
export function containment(sizeA, sizeB, shared) {
  const floor = Math.min(sizeA, sizeB);
  return floor ? shared / floor : 0;
}

/**
 * Raw cosine to the number on screen.
 *
 * A presentation choice, and disclosed as one — the card prints both, as
 * "62% match · cosine 0.31, unrelated pairs sit near 0.08".
 *
 * The curve exists because the honest number reads as a failing grade. Two real
 * libraries with genuinely shared taste land around 0.25–0.45; two strangers
 * land at 0.05–0.15. Printing "15%" would tell an above-average pair they have
 * nothing in common, which is a false statement about the data — the opposite
 * failure from the one a curve is usually accused of.
 *
 * Anchors rather than a magic exponent, so the mapping can be read, argued with
 * and re-fitted. These are a considered guess until tools/compare-calibrate.js
 * has run over real pairs; reset them from that output, not by feel.
 */
const CURVE = [
  [0, 0],
  [0.05, 10],
  [0.15, 35],
  [0.3, 60],
  [0.5, 80],
  [0.75, 92],
  [1, 100],
];

export function displayMatch(cos) {
  const x = Math.max(0, Math.min(1, Number(cos) || 0));
  for (let i = 1; i < CURVE.length; i++) {
    const [x0, y0] = CURVE[i - 1];
    const [x1, y1] = CURVE[i];
    if (x <= x1) return Math.round(y0 + ((x - x0) / (x1 - x0)) * (y1 - y0));
  }
  return 100;
}

/**
 * The word for a score.
 *
 * Derived from the raw cosine, never from the display number, so the words
 * cannot drift from the evidence if the curve above is ever re-fitted.
 */
const BANDS = [
  [0.05, 'faint'],
  [0.15, 'some'],
  [0.3, 'strong'],
  [0.55, 'very strong'],
  [Infinity, 'near-identical'],
];

export function bandFor(cos) {
  const x = Math.max(0, Math.min(1, Number(cos) || 0));
  return BANDS.find(([edge]) => x < edge)[1];
}

/** Per-country totals, rolled up from places. */
function countryVector(places) {
  const v = new Map();
  for (const p of places ?? []) {
    if (!p?.country_iso) continue;
    const n = Number(p.tracks);
    if (!Number.isFinite(n) || n <= 0) continue;
    v.set(p.country_iso, (v.get(p.country_iso) ?? 0) + n);
  }
  return v;
}

const byTracks = (x, y) => y.tracks - x.tracks;

/**
 * Everything one comparison has to say.
 *
 * @param {{artists: Array, places: Array, tracks: Array}} mine
 * @param {{artists: Array, places: Array, tracks: Array}} theirs
 *
 * Artists are `{id, name, tracks, place_qid, image_url}`, places are
 * `{qid, name, country_iso, lat, lon, tracks, artists}`, tracks are
 * `{id, name, artist_id}` — one row each, so a track vector is a set.
 *
 * Done in JS over two plain SELECTs rather than in SQL. Two Map builds and one
 * pass over a union of a few thousand entries is microseconds, and pushing it
 * into the database would buy nothing while costing the testability that is the
 * entire reason this file exists.
 */
export function compareLibraries(mine, theirs, { top = 10 } = {}) {
  const myArtists = toVector(mine.artists);
  const theirArtists = toVector(theirs.artists);
  const myPlaces = toVector(mine.places, 'qid');
  const theirPlaces = toVector(theirs.places, 'qid');
  const myCountries = countryVector(mine.places);
  const theirCountries = countryVector(theirs.places);
  // Track rows carry no count, so each is worth one. Cosine over two 0/1 vectors
  // is |A n B| / sqrt(|A||B|), a perfectly good overlap measure that needs no
  // special case here.
  const myTracks = new Map((mine.tracks ?? []).map((t) => [t.id, 1]));
  const theirTracks = new Map((theirs.tracks ?? []).map((t) => [t.id, 1]));

  const artistCos = cosine(myArtists, theirArtists);

  const sharedArtists = intersect(myArtists, theirArtists);
  const sharedPlaces = intersect(myPlaces, theirPlaces);
  const sharedTrackCount = intersect(myTracks, theirTracks).length;
  const sharedCountryCount = intersect(myCountries, theirCountries).length;

  const artistMeta = new Map((mine.artists ?? []).map((a) => [a.id, a]));
  const theirArtistMeta = new Map((theirs.artists ?? []).map((a) => [a.id, a]));
  const placeMeta = new Map();
  for (const p of [...(theirs.places ?? []), ...(mine.places ?? [])]) {
    // Mine last, so a place we both have is named the way my database names it —
    // the friend's copy of a name is a snapshot and may be staler.
    if (p?.qid) placeMeta.set(p.qid, p);
  }

  const namedArtist = (id, extra) => {
    const a = artistMeta.get(id) ?? theirArtistMeta.get(id) ?? {};
    return { id, name: a.name ?? id, image_url: a.image_url ?? null, ...extra };
  };

  const topPlaces = (places) =>
    [...(places ?? [])]
      .filter((p) => p?.qid && Number(p.tracks) > 0)
      .sort(byTracks)
      .slice(0, top)
      .map((p) => ({
        qid: p.qid,
        name: p.name,
        country_iso: p.country_iso ?? null,
        tracks: p.tracks,
      }));

  // Loudest on one side, absent from the other. Note "absent", not "quieter": an
  // artist they already have one track of is not one you can introduce them to.
  const onlyIn = (vec, other, meta) =>
    [...vec]
      .filter(([id]) => !other.has(id))
      .sort((x, y) => y[1] - x[1])
      .slice(0, top)
      .map(([id, tracks]) => {
        const a = meta.get(id) ?? {};
        return { id, name: a.name ?? id, tracks, image_url: a.image_url ?? null };
      });

  return {
    match: displayMatch(artistCos),
    band: bandFor(artistCos),
    // Cosine over eight artists is noise. Saying "too small to say much" is a
    // better answer than a confident 71 nobody can reproduce.
    confidence:
      myArtists.size < MIN_ARTISTS_FOR_CONFIDENCE ||
      theirArtists.size < MIN_ARTISTS_FOR_CONFIDENCE
        ? 'low'
        : 'ok',

    scores: {
      artists: artistCos,
      places: cosine(myPlaces, theirPlaces),
      // Reported, never blended into the headline, and never shown without its
      // baseline: two listeners in the same country score around 0.85 here no
      // matter how little else they share, so on its own it says nothing.
      countries: cosine(myCountries, theirCountries),
      tracks: cosine(myTracks, theirTracks),
    },

    shared: {
      artists: sharedArtists.length,
      tracks: sharedTrackCount,
      places: sharedPlaces.length,
      countries: sharedCountryCount,
      artistsOfSmaller: containment(myArtists.size, theirArtists.size, sharedArtists.length),
      tracksOfSmaller: containment(myTracks.size, theirTracks.size, sharedTrackCount),
    },

    size: {
      mine: { tracks: myTracks.size, artists: myArtists.size, places: myPlaces.size },
      theirs: { tracks: theirTracks.size, artists: theirArtists.size, places: theirPlaces.size },
    },

    topSharedArtists: sharedArtists
      .slice(0, top)
      .map((s) => namedArtist(s.id, { mine: s.mine, theirs: s.theirs })),

    topSharedPlaces: sharedPlaces.slice(0, top).map((s) => {
      const p = placeMeta.get(s.id) ?? {};
      return {
        qid: s.id,
        name: p.name ?? s.id,
        country_iso: p.country_iso ?? null,
        lat: p.lat ?? null,
        lon: p.lon ?? null,
        mine: s.mine,
        theirs: s.theirs,
      };
    }),

    myTopPlaces: topPlaces(mine.places),
    theirTopPlaces: topPlaces(theirs.places),

    onlyMine: onlyIn(myArtists, theirArtists, artistMeta),
    onlyTheirs: onlyIn(theirArtists, myArtists, theirArtistMeta),

    // Their artists, in cities you are deepest in — see the note on the
    // function. The arguments are the mirror of what they read as: the library
    // being drawn *from* comes first.
    discoveries: discoveriesFor(theirs, mine, theirArtists, myArtists, theirArtistMeta),
  };
}

/**
 * Artists in their library you have never heard, from cities you already love.
 *
 * This is the whole point of doing this inside Mappify rather than on any of the
 * sites that already compare two Spotify accounts. `onlyTheirs` sorted by track
 * count is true and useless — it prints their top ten whoever is looking. This
 * asks a question that needs the place graph: which artists do *they* have, that
 * I have *none* of, from the cities *I* am deepest in? The answer is different
 * for every pair, and it is the sentence people screenshot — "they have four
 * artists from Gothenburg you've never heard of".
 *
 * It used to run the other way, listing your artists for cities they were deep
 * in, under a step called "For them". Which is a fine thing to know and the
 * wrong thing to open a panel for: you are looking at somebody else's library to
 * find out what is in it, not to audit what you could post at them.
 *
 * The parameters are named from the perspective of the answer, so `source` is
 * the library the artists come out of and `target` is the one whose cities pick
 * them. Passing them the other way round is the old behaviour, exactly.
 *
 * Grouped by place rather than returned flat, because that sentence is about a
 * city and needs the city to be the unit.
 */
function discoveriesFor(source, seeker, sourceArtists, seekerArtists, sourceMeta) {
  // Your strongest cities, not all of them: an artist from a place you have a
  // single track from is not a discovery aimed at you.
  const DEPTH = 25;
  const target = new Map(
    [...(seeker.places ?? [])]
      .filter((p) => p?.qid && Number(p.tracks) > 0)
      .sort(byTracks)
      .slice(0, DEPTH)
      .map((p) => [p.qid, p])
  );
  if (!target.size) return [];

  const grouped = new Map();
  for (const a of source.artists ?? []) {
    if (!a?.id || !a.place_qid) continue;
    if (seekerArtists.has(a.id)) continue;
    if (!target.has(a.place_qid)) continue;
    if (!sourceArtists.has(a.id)) continue;
    if (!grouped.has(a.place_qid)) grouped.set(a.place_qid, []);
    grouped.get(a.place_qid).push({
      id: a.id,
      name: a.name ?? a.id,
      // Their count, since it is their artist: how much of this is waiting.
      tracks: sourceArtists.get(a.id),
      image_url: sourceMeta.get(a.id)?.image_url ?? null,
    });
  }

  return [...grouped]
    .map(([qid, artists]) => {
      const p = target.get(qid);
      return {
        qid,
        name: p.name,
        country_iso: p.country_iso ?? null,
        lat: p.lat ?? null,
        lon: p.lon ?? null,
        /** How deep you already are in this city — why the suggestion lands. */
        yourTracks: p.tracks,
        artists: artists.sort(byTracks),
      };
    })
    // Most to hear first, then by how much you already care about the place.
    .sort((x, y) => y.artists.length - x.artists.length || y.yourTracks - x.yourTracks);
}
