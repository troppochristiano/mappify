// The comparison maths, asserted directly.
//
//     node --test server/compare.test.js
//
// No database, no server, no fixtures on disk — compare.js imports nothing, so
// every claim it makes can be checked against two literals. That is the whole
// reason it is a separate file, and these are the properties that would
// otherwise only be discovered by someone noticing their match score looked
// wrong.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toVector,
  cosine,
  intersect,
  containment,
  displayMatch,
  bandFor,
  compareLibraries,
} from './compare.js';

const artist = (id, tracks, place_qid = null, name = id) => ({ id, name, tracks, place_qid });
const place = (qid, tracks, country_iso = 'US', name = qid) => ({
  qid,
  name,
  tracks,
  artists: 1,
  country_iso,
  lat: 0,
  lon: 0,
});
const lib = (artists = [], places = [], tracks = []) => ({ artists, places, tracks });

test('toVector sums duplicates rather than overwriting them', () => {
  // Two rows for one place is what a merged_into collapse produces at import.
  const v = toVector([{ id: 'a', tracks: 3 }, { id: 'a', tracks: 4 }, { id: 'b', tracks: 1 }]);
  assert.equal(v.get('a'), 7);
  assert.equal(v.size, 2);
});

test('toVector drops rows that cannot be counted', () => {
  const v = toVector([
    { id: 'a', tracks: 0 },
    { id: 'b', tracks: -5 },
    { id: 'c', tracks: 'lots' },
    { id: '', tracks: 9 },
    { id: null, tracks: 9 },
    { id: 'ok', tracks: 2 },
  ]);
  assert.deepEqual([...v], [['ok', 2]]);
});

test('a library compared with itself is exactly 1', () => {
  const v = toVector([artist('a', 300), artist('b', 3), artist('c', 17)]);
  // Exactly 1, not 0.9999999999999999 and not 1.0000000000000002 — the clamp in
  // cosine() exists so "100% match" cannot come out as 100.00000001.
  assert.equal(cosine(v, v), 1);
});

test('disjoint libraries score 0', () => {
  assert.equal(cosine(toVector([artist('a', 5)]), toVector([artist('b', 5)])), 0);
});

test('an empty library scores 0 rather than dividing by zero', () => {
  assert.equal(cosine(new Map(), toVector([artist('a', 5)])), 0);
  assert.equal(cosine(new Map(), new Map()), 0);
});

test('cosine is symmetric', () => {
  const a = toVector([artist('a', 40), artist('b', 2), artist('c', 9)]);
  const b = toVector([artist('b', 30), artist('c', 1), artist('d', 60)]);
  assert.equal(cosine(a, b), cosine(b, a));
});

test('a small library contained in a large one still scores high', () => {
  // The case Jaccard cannot express: 400 artists that are a perfect subset of
  // 6,000 would score 400/6000 = 0.067 there. Cosine is scale-invariant, so the
  // shape of the overlap is what counts and this comes out well above it.
  const big = toVector(Array.from({ length: 6000 }, (_, i) => artist(`a${i}`, 3)));
  const small = toVector(Array.from({ length: 400 }, (_, i) => artist(`a${i}`, 3)));
  const score = cosine(small, big);
  assert.ok(score > 0.25, `expected a contained library to score well, got ${score}`);
  assert.ok(score > 0.067 * 3, 'must beat what Jaccard would have said by a wide margin');
});

test('sqrt damping stops one huge artist deciding the answer', () => {
  // Both sides own the same 300-track discography and agree on nothing else.
  // Under raw counts that single artist would carry the score to nearly 1.
  const a = toVector([artist('huge', 300), ...Array.from({ length: 50 }, (_, i) => artist(`m${i}`, 4))]);
  const b = toVector([artist('huge', 300), ...Array.from({ length: 50 }, (_, i) => artist(`t${i}`, 4))]);
  const damped = cosine(a, b);
  const raw = cosine(a, b, (n) => n);
  assert.ok(raw > 0.9, `raw counts should be dominated by the big artist, got ${raw}`);
  assert.ok(damped < 0.75, `sqrt should pull it back, got ${damped}`);
});

test('intersect ranks by the smaller of the two counts', () => {
  const mine = toVector([artist('yours-only', 90), artist('mutual', 20)]);
  const theirs = toVector([artist('yours-only', 1), artist('mutual', 25)]);
  const [first] = intersect(mine, theirs);
  // 90+1 beats 20+25 on the sum, and would put an artist they have one track of
  // at the top of "what you share".
  assert.equal(first.id, 'mutual');
});

test('intersect keeps mine and theirs the right way round, whichever is smaller', () => {
  const mine = toVector([artist('x', 7), artist('y', 1), artist('z', 1)]);
  const theirs = toVector([artist('x', 4)]);
  assert.deepEqual(intersect(mine, theirs), [{ id: 'x', mine: 7, theirs: 4 }]);
  assert.deepEqual(intersect(theirs, mine), [{ id: 'x', mine: 4, theirs: 7 }]);
});

test('containment measures against the smaller side', () => {
  assert.equal(containment(6000, 400, 200), 0.5);
  assert.equal(containment(400, 6000, 200), 0.5);
  assert.equal(containment(0, 10, 0), 0);
});

test('displayMatch is monotone and pinned at both ends', () => {
  assert.equal(displayMatch(0), 0);
  assert.equal(displayMatch(1), 100);
  assert.equal(displayMatch(0.3), 60);
  let prev = -1;
  for (let x = 0; x <= 1.0001; x += 0.01) {
    const y = displayMatch(x);
    assert.ok(y >= prev, `curve went backwards at ${x}`);
    prev = y;
  }
});

test('displayMatch survives nonsense rather than printing NaN', () => {
  for (const bad of [NaN, undefined, null, -3, 12, 'x']) {
    const y = displayMatch(bad);
    assert.ok(Number.isInteger(y) && y >= 0 && y <= 100, `${bad} gave ${y}`);
  }
});

test('bands come from the raw cosine, not the display number', () => {
  assert.equal(bandFor(0.01), 'faint');
  assert.equal(bandFor(0.1), 'some');
  assert.equal(bandFor(0.2), 'strong');
  assert.equal(bandFor(0.4), 'very strong');
  assert.equal(bandFor(1), 'near-identical');
});

test('a library compared with itself reports a perfect match', () => {
  const me = lib(
    [artist('a', 30, 'Q60'), artist('b', 5, 'Q90')],
    [place('Q60', 30), place('Q90', 5)],
    [{ id: 't1' }, { id: 't2' }]
  );
  const r = compareLibraries(me, me);
  assert.equal(r.scores.artists, 1);
  assert.equal(r.match, 100);
  assert.equal(r.band, 'near-identical');
  assert.equal(r.shared.artists, 2);
  assert.equal(r.shared.tracks, 2);
  assert.deepEqual(r.onlyMine, []);
  assert.deepEqual(r.onlyTheirs, []);
});

test('compareLibraries is symmetric in every score it reports', () => {
  const a = lib(
    [artist('a', 40, 'Q60'), artist('b', 2, 'Q90'), artist('c', 9, 'Q60')],
    [place('Q60', 49), place('Q90', 2)],
    [{ id: 't1' }, { id: 't2' }, { id: 't3' }]
  );
  const b = lib(
    [artist('b', 30, 'Q90'), artist('d', 60, 'Q84', 'D')],
    [place('Q90', 30), place('Q84', 60, 'GB')],
    [{ id: 't2' }, { id: 't9' }]
  );
  const ab = compareLibraries(a, b);
  const ba = compareLibraries(b, a);
  assert.deepEqual(ab.scores, ba.scores);
  assert.equal(ab.match, ba.match);
  assert.equal(ab.shared.artists, ba.shared.artists);
  assert.equal(ab.shared.tracks, ba.shared.tracks);
  assert.equal(ab.shared.artistsOfSmaller, ba.shared.artistsOfSmaller);
  // Only the deliberately one-sided lists differ, and they swap.
  assert.deepEqual(ab.onlyMine, ba.onlyTheirs);
  assert.deepEqual(ab.onlyTheirs, ba.onlyMine);
});

test('confidence drops when either side is too small to say anything', () => {
  const tiny = lib([artist('a', 1)], [place('Q60', 1)]);
  const big = lib(
    Array.from({ length: 40 }, (_, i) => artist(`a${i}`, 2)),
    [place('Q60', 80)]
  );
  assert.equal(compareLibraries(tiny, big).confidence, 'low');
  assert.equal(compareLibraries(big, big).confidence, 'ok');
});

test('discoveries are artists you lack, from cities you are deep in', () => {
  const mine = lib(
    [artist('shared', 8, 'Q25287', 'Both Of Us')],
    [place('Q25287', 60, 'SE', 'Gothenburg'), place('Q1490', 1, 'JP')]
  );
  const theirs = lib(
    [
      artist('unknown-to-me', 12, 'Q25287', 'Hoola Bandoola'), // Gothenburg
      artist('also-new', 4, 'Q25287', 'Second Gothenburger'),
      artist('shared', 30, 'Q25287', 'Both Of Us'),
      // A city of theirs I have one track from, which is not a city I am deep in
      // — the DEPTH cut is by my count, so this stays out on its own merits once
      // there are 25 better ones. Here it is kept honest by the artist rule
      // below instead: I have none of them either, so what proves the cut is the
      // Gothenburg-only result, not this row.
      artist('elsewhere', 30, 'Q1490', 'Tokyo Act'),
      artist('unplaced', 50, null, 'No Origin'),
    ],
    [place('Q25287', 24, 'SE'), place('Q1490', 30, 'JP')]
  );

  const { discoveries } = compareLibraries(mine, theirs);

  const gbg = discoveries.find((d) => d.qid === 'Q25287');
  assert.ok(gbg, 'the city I am deepest in should be there');
  assert.equal(gbg.name, 'Gothenburg', 'named the way my own database names it');
  assert.equal(gbg.yourTracks, 60, 'how deep I am, not how deep they are');
  assert.deepEqual(
    gbg.artists.map((a) => a.id),
    ['unknown-to-me', 'also-new'],
    'an artist I already have is not a discovery, and order is densest first'
  );
  assert.deepEqual(
    gbg.artists.map((a) => a.tracks),
    [12, 4],
    'the counts are theirs — how much of that artist is waiting'
  );
});

test('discoveries are empty when you have no places at all', () => {
  const theirs = lib([artist('a', 5, 'Q60')], [place('Q60', 5)]);
  assert.deepEqual(compareLibraries(lib([], []), theirs).discoveries, []);
});

test('a place we both have is named the way my database names it', () => {
  // Their file is a snapshot and its copy of a name may be staler than mine.
  const mine = lib([artist('a', 5, 'Q60')], [place('Q60', 5, 'US', 'New York City')]);
  const theirs = lib([artist('a', 3, 'Q60')], [place('Q60', 3, 'US', 'New York')]);
  assert.equal(compareLibraries(mine, theirs).topSharedPlaces[0].name, 'New York City');
});

test('country scores are reported but never fed into the headline', () => {
  // Two libraries sharing a country and nothing else. The country score is near
  // 1 and the headline must be untouched by it.
  const a = lib([artist('a', 10, 'Q60')], [place('Q60', 10, 'US')]);
  const b = lib([artist('b', 10, 'Q65')], [place('Q65', 10, 'US')]);
  const r = compareLibraries(a, b);
  assert.equal(r.scores.countries, 1);
  assert.equal(r.scores.artists, 0);
  assert.equal(r.match, 0);
  assert.equal(r.band, 'faint');
});
