# Roadmap

Where the work stands and what comes next, in order. Each step is blocked by the
one above it.

## 1. Place hierarchy — done

Containment is computable. 519 of 563 places sit on a P131 chain (the other 44
are countries, which have no parent), median depth 3, 1086 chain nodes.

`admin_parent_qid` is a **second column**, never a widening of `parent_qid`.
`parent_qid` deliberately only accepts settlements — that is what stops Atlanta
nesting under Fulton County in the browse tree. `is_city` cannot substitute for
it either: Braintree and Brooklyn are both `is_city = 0`, so any rule built on
that would also block Wu-Tang artists from landing on Staten Island.

The chain itself lives in its own table, `admin_areas`, not in `places`. Writing
520 counties and states into `places` was tried and reverted: every rendering
path reads that table, so Bologna, Montréal, Lyon and four others were pushed a
level down behind shells like "Urban agglomeration of Montreal", and Texas
became something you could pin an artist to. `collapseWrappers()` rescued five
of the seven and correctly refused the rest — Wikidata types Bordeaux Métropole
as a city. `admin_areas` answers "what contains what" and nothing renders it, so
`/api/tree`, `/api/map` and `/api/links` come out of a run byte-identical.

- `server/admin-chain.js` — `resolveChains(db, qids)`, callable for any QID, not
  just places that already exist. Step 2 needs that: a place read out of
  "Rappers from Compton" is usually not in `places` yet.
- `server/containment.js` — `isInside(a, b)`, `depth(qid)`, `chain(qid)`.
- `tools/resolve-place-chains.js` — the CLI. Idempotent; a second run fetches
  nothing.
- `places.admin_parent_qid` and `area.admin_parent_qid` in the index hold the
  single hop the index can carry, so a fresh install has containment before
  anyone runs the tool. `lookupAreas` asks `pragma_table_info` first, so
  pointing at an index that predates the column still works.

The index's copy is one hop and picks the lowest QID when P131 gives several,
because it has no chain to judge with. `resolveChains` has the whole graph and
prefers the *nearest* parent, so its value wins wherever both know a place.

## 2. Unblock the scene pass — done, and applied

`tools/fix-artist-scenes.js` moved 92 artists off a birthplace and onto the
scene Wikipedia files them under. 148 artists now carry an `origin_wiki_qid`.
Reverse the lot with `node tools/fix-artist-origins.js --revert`.

Two containment drops replaced the old depth floor, both applied before any
vote is counted:

1. **Contains the birthplace** — a vaguer restatement, never new evidence.
   Manhattan contains 2Pac's East Harlem, so Baltimore stands alone and he
   moves. New York City contains Staten Island, so Raekwon stays. Texas
   contains Fort Worth; Essex contains Braintree.
2. **Seat of an area just above the birthplace** — too ambiguous to act on.
   "Musicians from Los Angeles" is written about the county as readily as the
   city, which is what keeps Snoop in Long Beach and YG in Compton even though
   Los Angeles outvotes them 3–1. Containment alone would not have: LA does not
   contain Long Beach. Bounded to two levels, or England's P36 would make London
   unclaimable for every English artist and Nico could never leave Köln.

`--why "Snoop Dogg,2Pac"` prints the reasoning per artist, which is how those
cases are checked rather than asserted.

Known costs, all documented in the tool's header: Bowie moves Brixton → London,
because Wikidata puts London beside the boroughs rather than above them and no
property says otherwise (P131 and P150 were both checked); Outkast stay in East
Point, since Atlanta is the seat of the county they were born in; a category
naming a state can beat a wrong city elsewhere, so Khalid moves from Fort
Stewart to Texas.

Also fixed here: the Wikipedia category fetch answered a burst with an HTML
rate-limit page and the old code logged and skipped, silently turning 20 artists
per lost batch into "no music category". It now retries with backoff and counts
what never came back.

On the map: 363 points became 343 as artists consolidated onto scenes, London
went from 183 tracks to 261, and unmapped tracks fell from 1042 to 1035.

## 3. Share the derived fixes — done

`node tools/push-derived.js` sends four tables to the index, and the import job
reads them back:

| table | rows | what it carries |
| --- | --- | --- |
| `place` | 563 | the settlement tree, coordinates, `capital_qid`, `admin_parent_qid` |
| `admin_area` | 523 | the containment skeleton — counties and states |
| `artist_origin_wiki` | 148 | scene origins, keyed by MBID so any library can use them |
| `artist_place` | 89 | the tail MusicBrainz has no area for |

Kept a separate table from `place`, exactly as locally: merging them would nest
Bologna behind an administrative shell on every install that pulled it.
`capital_qid` is not optional — without P36 a friend cannot reproduce the seat
rule and would move Snoop Dogg to Los Angeles.

**Verified end to end.** A copy of the database with `places`, `place_areas`,
`admin_areas`, `place_qid` and `origin_wiki_qid` all wiped rebuilt itself from
the index in **2.7 seconds**: 562 places, 1033 chain nodes, all 148 origins and
89 artist places, nothing dangling. Its `/api/tree` and `/api/map` match the real
database exactly — 386 nodes, 343 points, same unmapped count. The only
difference is two labels where the MusicBrainz area name wins over the Wikidata
one ("Westminster" for "City of Westminster").

Ordering matters and is load-bearing: `syncDerivedArtists` runs *before*
`syncPlacesFromIndex`, so the latter's Wikidata fallback only chases artists the
index has never seen. `syncDerivedPlaces` runs after both, when every route's
QIDs are known.

Facts belong in the index; opinions do not. `artists.origin_override_qid` is a
manual escape hatch, is empty, is never pushed, and nothing should be designed
around it.

`area.admin_parent_qid` also exists but is superseded by `place`: an `area` row
can only carry one hop, and a county is usually not a MusicBrainz area at all.
It fills itself for any area resolved from now on; the `--coords` backfill for
the other 16k is not worth the SPARQL run.

## 4. Origins during sync — done

An import now reads scene origins out of the index for free, and works out
whatever the index could not answer itself. The pass moved to `server/scenes.js`
so the job and `tools/fix-artist-scenes.js` run exactly the same code; the CLI is
a printer over it. Its header is where the rules and their known costs live.

Order inside an import: shared corrections, then areas, then place rows and
chains, then shells folded in, then the scene pass over whatever is left. Only
artists nobody has resolved reach that last step, so a second import costs
nothing and a first one pays once.

**Bounded at 300 artists per import**, most-played first, `MAPPIFY_SCENES_LIMIT`
to change it and `0` to turn it off. This is the only part of an import that
scales with artists nobody has ever looked at — a fresh 2000-artist library would
otherwise spend minutes on Wikipedia while someone watches a progress bar. What
is left over is printed with the command that finishes the job, rather than
quietly dropped. A failure here is caught and logged: the library is already in,
and an enrichment must not fail an import.

The retry and backoff the old note asked for is in too, and it mattered — the
category fetch answers bursts with an HTML rate-limit page, and 12 of 50 batches
died silently on the first full run, each taking 20 artists with it.

One property worth knowing: **the pass converges rather than finishing.** Every
run resolves containment chains on demand and leaves them behind, so the next run
can judge candidates it previously had to refuse. A re-run right after the first
93 moves found 23 more (Waka Flocka → Atlanta, Ecco2k → Stockholm). 171 artists
now carry a scene origin. Re-running until it returns nothing is the honest way
to finish.

Anything derived locally is worth sending on with `node tools/push-derived.js`,
which is still a maintainer step: a friend's install holds a read-only token.

## 5. Multi-tenancy

Today the schema is single-tenant: `auth` holds one row and the library tables
have no account column. A friend hitting a hosted instance would see the host's
library through the host's token.

- **A database per user, not an owner column.** One forgotten `WHERE user_id = ?`
  leaks somebody's listening history; `openDb(userId)` cannot leak by omission.
  The MusicBrainz index stays global.
- **Spotify OAuth is the login.** No passwords, no separate account system.
- **Scope every write endpoint** to the caller: `/api/artist-origin`,
  `/api/import`, `/api/setup`, `/api/auth/*`.
- **The allowlist is the sharp edge.** Spotify Development Mode caps an app at 5
  authorised users, and the host must add each friend's email by hand in the
  dashboard. Until they do, the friend hits a raw Spotify error and reads it as
  "broken". Catch it and say "ask the host to add you" instead.

The 5-user cap is per Spotify *application*, so the self-host pattern works: each
host registers their own app and gets their own five slots. Viewing a hosted map
is uncapped — the limit only binds on connecting an account.

## 6. Public repo

- `.env` and `mappify.db` must be gitignored: they hold tokens and a full library
- `.env.example`, and a README covering Spotify app registration
- one-command deploy
