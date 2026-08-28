import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { api, type SourceRow } from '../lib/api'
import { ChipActions } from './ChipActions'
import { Thumb } from './Thumb'
import { chipTarget, type Chip, type ChipMode } from '../lib/filters'

/**
 * Browsing the library to build a filter, rather than searching it.
 *
 * Searching answers "is this in here?". This answers "what is in here?" — which
 * is the question you have when you do not yet know what you want to filter by,
 * and the one the panel could not answer: chips could only be made from search
 * results, so unless you already knew a name the only filter within reach was a
 * playlist, because the empty query happens to list playlists.
 *
 * Both lists deliberately show the *whole* library rather than what survives the
 * chips already applied. A list that hides what you have not picked yet can only
 * narrow — you could never add a second artist to a selection, because the
 * moment you picked the first, the second would be gone.
 */

export type BrowseRow = {
  kind: 'artist' | 'playlist'
  id: string
  label: string
  /** The right-hand column: a count, an origin, whatever tells them apart. */
  sub: string
  /** A portrait or a cover, if the library has one for this row. */
  image?: string | null
}

/** How this target is chipped right now, if at all. Keyed by `chipTarget`. */
export type Applied = Map<string, ChipMode>

/** What every list in here needs to offer a row as a filter. */
type Picking = {
  applied: Applied
  onAdd: (chip: Chip) => void
  onRemove: (target: string) => void
}

function Rows({ rows, applied, onAdd, onRemove }: Picking & { rows: BrowseRow[] }) {
  return (
    <ul className="menu-list browse-rows">
      {rows.map((row) => {
        const target = chipTarget(row)
        return (
          <li key={target} className="menu-row browse-row">
            <Thumb src={row.image} />
            <span className="browse-label">
              <span className="menu-name">{row.label}</span>
              <span className="menu-count">{row.sub}</span>
            </span>
            <ChipActions
              label={row.label}
              mode={applied.get(target)}
              onPick={(mode) => onAdd({ kind: row.kind, mode, id: row.id, label: row.label })}
              onClear={() => onRemove(target)}
            />
          </li>
        )
      })}
    </ul>
  )
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

/** One request per page of the artist list. Well under the endpoint's 200 cap. */
const PAGE = 100

/** Holds a value still while it is changing, so typing is not a request each. */
function useDebounced<T>(value: T, ms: number) {
  const [held, setHeld] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setHeld(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return held
}

/**
 * Every artist in the library, biggest first.
 *
 * Paged rather than fetched whole: the endpoint caps a request at 200 and a
 * library runs to thousands. The narrowing box sends its text to the server
 * rather than filtering what has been loaded — otherwise typing would only
 * search the pages you happened to have scrolled to, which is worse than not
 * offering it.
 */
export function ArtistBrowser({ applied, onAdd, onRemove }: Picking) {
  const [text, setText] = useState('')
  // Typing is a server query, so it waits for a pause rather than firing per
  // keystroke down a list this long.
  const q = useDebounced(text.trim(), 200)

  const artists = useInfiniteQuery({
    queryKey: ['browse-artists', q],
    queryFn: ({ pageParam }) => api.artists({ q: q || undefined, limit: PAGE, offset: pageParam }),
    initialPageParam: 0,
    // The endpoint caps a single request at 200, so reaching a library of
    // thousands means paging rather than asking for it all at once.
    getNextPageParam: (last, pages) => {
      const seen = pages.reduce((n, page) => n + page.items.length, 0)
      return seen < last.total ? seen : undefined
    },
    placeholderData: keepPreviousData,
  })

  const rows: BrowseRow[] = useMemo(
    () =>
      (artists.data?.pages ?? []).flatMap((page) =>
        page.items.map((a) => ({
          kind: 'artist' as const,
          id: a.spotify_id,
          label: a.name,
          sub: plural(a.tracks, 'track'),
          image: a.image_url,
        }))
      ),
    [artists.data]
  )

  const total = artists.data?.pages[0]?.total ?? 0

  return (
    <>
      <input
        type="search"
        className="search-input browse-find"
        value={text}
        placeholder="narrow the list"
        onChange={(e) => setText(e.target.value)}
        autoComplete="off"
        aria-label="Narrow the artist list"
      />

      {artists.isLoading ? (
        <p className="panel-sub">Loading…</p>
      ) : !rows.length ? (
        <p className="empty">No artists match that.</p>
      ) : (
        <>
          <p className="panel-sub browse-count">
            {rows.length < total ? `${rows.length} of ${total} artists` : plural(total, 'artist')}
          </p>
          <Rows rows={rows} applied={applied} onAdd={onAdd} onRemove={onRemove} />
          {artists.hasNextPage && (
            <button
              className="ghost browse-more"
              disabled={artists.isFetchingNextPage}
              onClick={() => artists.fetchNextPage()}
            >
              {artists.isFetchingNextPage ? 'Loading…' : `Show ${Math.min(PAGE, total - rows.length)} more`}
            </button>
          )}
        </>
      )}
    </>
  )
}

/**
 * Where your music came from: Liked Songs, then playlists, then albums.
 *
 * Grouped by kind because they are not interchangeable — "Liked Songs" is one
 * thing and a saved album is another, and the flat list loses a distinction the
 * data already carries.
 *
 * Only sources with something imported are offered. `/api/sources` returns every
 * row including ones that imported nothing, and a chip for one of those is a
 * filter that empties the globe with no way to see why.
 */
export function LibraryBrowser({ applied, onAdd, onRemove }: Picking) {
  // Like every other list in here: without it the rows empty out between
  // refetches and the list jumps.
  const sources = useQuery({
    queryKey: ['sources'],
    queryFn: api.sources,
    placeholderData: keepPreviousData,
  })
  const [find, setFind] = useState('')

  const groups = useMemo(() => {
    // Narrowed here rather than at the server: unlike the artist list this is
    // already fully loaded, so filtering what is in hand is both instant and
    // complete. A saved-album library runs to hundreds and is mostly not what
    // you came for.
    const needle = find.trim().toLowerCase()
    const live = (sources.data?.sources ?? [])
      .filter((s) => s.imported > 0)
      .filter((s) => !needle || s.name.toLowerCase().includes(needle))
    const of = (kind: (s: SourceRow) => boolean) =>
      live.filter(kind).sort((a, b) => b.imported - a.imported)
    return [
      { title: 'Liked Songs', rows: of((s) => s.kind === 'liked') },
      { title: 'Playlists', rows: of((s) => s.kind === 'playlist') },
      { title: 'Saved albums', rows: of((s) => s.kind === 'album') },
    ].filter((g) => g.rows.length)
  }, [sources.data, find])

  return (
    <>
      <input
        type="search"
        className="search-input browse-find"
        value={find}
        placeholder="narrow the list"
        onChange={(e) => setFind(e.target.value)}
        autoComplete="off"
        aria-label="Narrow the library list"
      />
      {!groups.length && (
        <p className="empty">{find.trim() ? 'Nothing matches that.' : 'Nothing imported yet.'}</p>
      )}
      {groups.map((g) => (
        <div className="search-group" key={g.title}>
          <h2 className="search-group-head">{g.title}</h2>
          <Rows
            rows={g.rows.map((s) => ({
              kind: 'playlist' as const,
              id: String(s.id),
              label: s.name,
              sub: plural(s.imported, 'track'),
              image: s.image_url,
            }))}
            applied={applied}
            onAdd={onAdd}
            onRemove={onRemove}
          />
        </div>
      ))}
    </>
  )
}
