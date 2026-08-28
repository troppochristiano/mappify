// Turning the search panel's chips into SQL.
//
// A chip is one clause of "show me this, not that": a playlist, a place or an
// artist, either included or excluded. They arrive as repeated `f` params, a
// leading `-` meaning exclude:
//
//     ?f=place:Q60&f=-place:Q30&f=playlist:12&f=-artist:3jOstUTkEu2JkjvRdBA5Gu
//
// This module exists as its own file rather than as more of api.js so the
// parser and the builder can be imported and asserted on without a server, a
// session or a database — which, for the one piece of this app that composes
// SQL from user input, is worth a file of its own.

import { ARTIST_PLACE, PLACE_SUBTREE } from './sql.js';

/**
 * How many chips of each kind one request may carry.
 *
 * Per kind rather than one number, because the kinds do not cost the same. An
 * artist or playlist chip is an `IN (…)` list over an indexed column and a
 * hundred of them is nothing; a place chip is a recursive CTE walking the
 * settlement hierarchy, which is the reason there is a cap here at all.
 *
 * The numbers are set where a person browsing could plausibly reach them and
 * not before: picking forty artists off a list is a reasonable thing to do,
 * whereas nobody picks sixteen countries by hand.
 */
const CAPS = { sources: 128, places: 16, artists: 128 };

/**
 * An absolute bound on the tokens read out of the URL, before any of them are
 * even looked at. Not a policy about filters — a limit on how much work a
 * hand-written URL can ask this function to do.
 */
const MAX_TOKENS = 512;

const KINDS = ['playlist', 'place', 'artist'];

/**
 * What each kind of id is allowed to look like.
 *
 * This is the injection boundary and it fails closed: anything that does not
 * match is dropped, not escaped and not passed through. Sources are integers
 * because they are interpolated (see `filterSql`); places and artists are bound,
 * but they are validated anyway — a chip for a place that cannot exist is a bug
 * or an attack, and neither deserves a query.
 */
const VALID = {
  playlist: (raw) => {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  },
  place: (raw) => (/^Q\d+$/.test(raw) ? raw : null),
  artist: (raw) => (/^[A-Za-z0-9]{16,32}$/.test(raw) ? raw : null),
};

const empty = () => ({ sources: [], places: [], artists: [] });
const BUCKET = { playlist: 'sources', place: 'places', artist: 'artists' };

/**
 * Read the chips out of a request URL.
 *
 * `source=<id>` is still understood as an included playlist, so links and
 * bookmarks made before the chips existed keep working. The client rewrites
 * such a URL into the `f` form the moment it opens one, so this can go once
 * nobody is sitting on an old link — it costs three lines until then.
 */
export function parseFilters(url) {
  const f = {
    include: empty(),
    exclude: empty(),
    /**
     * What happened to the chips that were asked for.
     *
     * Here because a cap that drops chips quietly is worse than a low cap: the
     * URL says forty filters, the globe shows thirty-two, and nothing on screen
     * admits the difference. Raising the cap only makes that rarer, which makes
     * it harder to recognise when it does happen. So the count comes back with
     * the answer and the panel can say "32 of 40 applied".
     */
    limits: { requested: 0, applied: 0, dropped: [], invalid: 0 },
  };
  const raw = url.searchParams.getAll('f').slice(0, MAX_TOKENS);

  const legacy = url.searchParams.get('source');
  if (!raw.length && legacy) {
    const id = VALID.playlist(legacy);
    if (id) {
      f.include.sources.push(id);
      f.limits.requested = 1;
      f.limits.applied = 1;
    }
    return f;
  }

  for (const token of raw) {
    const mode = token.startsWith('-') ? 'exclude' : 'include';
    const body = mode === 'exclude' ? token.slice(1) : token;
    const at = body.indexOf(':');
    const kind = at < 1 ? null : body.slice(0, at);
    if (!kind || !KINDS.includes(kind)) {
      f.limits.invalid++;
      continue;
    }
    const id = VALID[kind](body.slice(at + 1));
    if (id == null) {
      f.limits.invalid++;
      continue;
    }
    const bucket = f[mode][BUCKET[kind]];
    // The same chip listed twice is one filter, not one applied and one lost.
    if (bucket.includes(id)) continue;
    f.limits.requested++;

    // Counted across both modes: the cap is about how much SQL one kind can
    // build, and including a place costs the same subtree walk as excluding it.
    const held = f.include[BUCKET[kind]].length + f.exclude[BUCKET[kind]].length;
    if (held >= CAPS[BUCKET[kind]]) {
      // First come, first served, in the order the URL lists them — so which
      // chips survive is at least predictable rather than arbitrary.
      f.limits.dropped.push(`${kind}:${id}`);
      continue;
    }
    bucket.push(id);
    f.limits.applied++;
  }
  return f;
}

/** True when nothing survived parsing, so a caller can skip the work entirely. */
export const isEmpty = (f) =>
  !Object.values(f.include).some((v) => v.length) &&
  !Object.values(f.exclude).some((v) => v.length);

/**
 * The chips as `kind:id` strings, which is how the client keys their labels.
 */
export function filterTargets(f) {
  const out = [];
  for (const mode of ['include', 'exclude']) {
    for (const [kind, bucket] of Object.entries(BUCKET)) {
      for (const id of f[mode][bucket]) out.push(`${kind}:${id}`);
    }
  }
  return out;
}

/**
 * The chips as SQL, in two pieces because they belong at two different depths.
 *
 * `join` narrows the `track_artists ta` join — which is what everything the map
 * shows is counted through, so restricting it there makes "only this playlist"
 * mean the same thing in the dots, the counts, the tree and the artist lists at
 * once. `where` narrows the artist row itself.
 *
 * Includes AND across kinds and OR within one: two playlists means *either*
 * playlist, because the intersection of two playlists is nearly always empty
 * and is not what picking two of them means. Excludes are the negation of the
 * same union — none of these.
 *
 * Source ids are interpolated, as they were before this module existed, because
 * the call sites use positional parameters in different orders and threading one
 * more through each is how the wrong value lands in the wrong slot. They are
 * integers by the time they get here, so there is nothing to inject. Qids and
 * Spotify ids are strings and are bound — every `?` in the returned SQL is in
 * `where`, and `where` is always appended last, so the ordering stays trivial.
 */
export function filterSql(f) {
  const join = [];
  const where = [];
  const params = [];

  const inSources = (ids) =>
    `EXISTS (SELECT 1 FROM track_sources ts
             WHERE ts.track_id = ta.track_id AND ts.source_id IN (${ids.join(',')}))`;
  if (f.include.sources.length) join.push(` AND ${inSources(f.include.sources)}`);
  if (f.exclude.sources.length) join.push(` AND NOT ${inSources(f.exclude.sources)}`);

  // One subtree per place, so excluding the United States takes every city
  // under it with it and excluding New York City takes Brooklyn.
  const subtrees = (qids) => qids.map(() => PLACE_SUBTREE).join(' OR ');
  if (f.include.places.length) {
    where.push(`(${subtrees(f.include.places)})`);
    params.push(...f.include.places);
  }
  if (f.exclude.places.length) {
    // The NULL guard is not optional. ARTIST_PLACE is NULL for every artist
    // whose origin is unknown, `NULL IN (…)` is NULL, and SQLite reads that as
    // false — so a plain NOT would delete every unplaced artist along with the
    // country being excluded, quietly changing the unmapped count on the globe.
    where.push(`(${ARTIST_PLACE} IS NULL OR NOT (${subtrees(f.exclude.places)}))`);
    params.push(...f.exclude.places);
  }

  const marks = (ids) => ids.map(() => '?').join(',');
  if (f.include.artists.length) {
    where.push(`a.spotify_id IN (${marks(f.include.artists)})`);
    params.push(...f.include.artists);
  }
  if (f.exclude.artists.length) {
    where.push(`a.spotify_id NOT IN (${marks(f.exclude.artists)})`);
    params.push(...f.exclude.artists);
  }

  return {
    join: join.join(''),
    where: where.length ? ` AND ${where.join(' AND ')}` : '',
    params,
  };
}

/** Parse and build in one step, which is what every call site actually wants. */
export function filtersFor(url) {
  return filterSql(parseFilters(url));
}
