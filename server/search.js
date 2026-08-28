// Matching text against artists, in one place.
//
// Two callers ask the same question — /api/artists, which lists them, and
// /api/search, which offers them as filter chips — and they must not drift:
// a name that finds an artist in one has to find them in the other. So the
// clause is built here rather than written twice.

import { ARTIST_PLACE_NAME, CITY, COUNTRY } from './sql.js';

/**
 * A query as tokens, with the FTS operators stripped.
 *
 * `"` `*` `%` `_` all mean something to either FTS5 or LIKE, and none of them
 * mean anything to somebody typing a band's name.
 */
export function tokenise(q) {
  return (q ?? '')
    .trim()
    .split(/\s+/)
    .map((tok) => tok.replace(/["*%_]/g, ''))
    .filter(Boolean);
}

/**
 * `WHERE` clauses matching an artist by name, place or country.
 *
 * Two implementations of one rule, chosen by whether the runtime has FTS5 —
 * Node only gained it in 24, and a Node 22 install has to keep working. The
 * indexed path prefix-matches the last token so typing feels live; the scanned
 * path requires every token to appear somewhere, which is the same "and", just
 * without an index behind it. At one person's library that is fine.
 *
 * The scanned path reaches through to the *resolved* place name as well as the
 * raw city — a correlated subquery per token per row — so that the two paths
 * agree about a pinned artist. The indexed path gets there through the search
 * index, which is built from the same definition (see `reindexSearch`).
 */
export function artistMatch(q, fts) {
  const tokens = tokenise(q);
  const clauses = [];
  const params = [];
  if (!tokens.length) return { clauses, params };

  if (fts) {
    clauses.push(
      'a.spotify_id IN (SELECT spotify_id FROM artist_search WHERE artist_search MATCH ?)'
    );
    params.push(tokens.map((tok) => `"${tok}"*`).join(' '));
  } else {
    for (const tok of tokens) {
      clauses.push(
        `(a.name LIKE ? OR COALESCE(${ARTIST_PLACE_NAME}, '') LIKE ?` +
          ` OR COALESCE(${CITY}, '') LIKE ? OR COALESCE(${COUNTRY}, '') LIKE ?)`
      );
      params.push(`%${tok}%`, `%${tok}%`, `%${tok}%`, `%${tok}%`);
    }
  }
  return { clauses, params };
}

/**
 * The same question, asked of an imported library.
 *
 * A separate function rather than a parameter on `artistMatch`, because the two
 * cannot share an implementation honestly: that one reaches through
 * `ARTIST_PLACE` to resolve where an artist is, and a friend's rows have no
 * origin to resolve — the file already carries the answer as a flat `place_qid`.
 * Pretending otherwise would mean writing a COALESCE over columns that are not
 * there.
 *
 * Always the scanned path, never FTS. `artist_search` is built from your own
 * library and friend rows are deliberately kept out of it (see share.js), so
 * there is no index to consult. At one imported library — a couple of thousand
 * rows — a LIKE per token is not worth an index that would also have to be
 * rebuilt on every import and torn down on every removal.
 */
export function friendArtistMatch(q) {
  const tokens = tokenise(q);
  const clauses = [];
  const params = [];
  for (const tok of tokens) {
    clauses.push(
      `(fa.name LIKE ?
        OR COALESCE((SELECT fp.name FROM friend_places fp
                      WHERE fp.friend_id = fa.friend_id AND fp.qid = fa.place_qid), '') LIKE ?)`
    );
    params.push(`%${tok}%`, `%${tok}%`);
  }
  return { clauses, params };
}
