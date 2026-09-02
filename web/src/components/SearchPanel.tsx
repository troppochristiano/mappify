import { useEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  api,
  type ArtistHit,
  type Owner,
  type PlaceResult,
  type PlaylistHit,
  type SearchScope,
} from '../lib/api'
import { FilterChips } from './FilterChips'
import { ChipActions } from './ChipActions'
import { Thumb } from './Thumb'
import { ArtistBrowser, LibraryBrowser } from './BrowseList'
import type { Chip, ChipKind } from '../lib/filters'
import { chipTarget, labelsQuery } from '../lib/filters'

/**
 * Search, and the filters it builds.
 *
 * One tab in the dock. It mounts when you open that tab and unmounts when you
 * leave it, so there is no open prop and no early return: not being on screen
 * and not existing are the same thing here.
 *
 * Two things happen here and they are deliberately different acts. Typing
 * *lights* the globe: the dots that match stay lit, the rest go quiet, and it
 * lasts exactly as long as the text does. Adding a chip *narrows* it: whatever
 * falls outside stops being on the map at all, and it stays until you take it
 * off. Which is why Enter adds a chip and Cmd-Enter merely goes there.
 *
 * The results are the top few of each kind rather than everything, because they
 * are candidates for a chip rather than a list to read. What matched in full is
 * already on the globe, lit.
 *
 * Which is why there are two other modes beside it. Searching needs you to know
 * a name; browsing is for when you do not, and a top-eight list is the wrong
 * shape for that. Artists and Library are the same act — build a chip — reached
 * by looking instead of typing.
 */

/** `friendId` says which imported library a row is from — several are searched. */
type Row =
  | { kind: 'artist'; id: string; label: string; sub: string; owner: Owner; friendId?: number; hit: ArtistHit }
  | { kind: 'place'; id: string; label: string; sub: string; owner: Owner; friendId?: number; hit: PlaceResult }
  | { kind: 'playlist'; id: string; label: string; sub: string; owner: Owner; friendId?: number; hit: PlaylistHit }

type Mode = 'search' | 'artists' | 'library'

type Props = {
  text: string
  onText: (next: string) => void
  chips: Chip[]
  onAdd: (chip: Chip) => void
  onToggle: (target: string) => void
  onRemove: (target: string) => void
  onClear: () => void
  /**
   * Go to a place on the globe — the same act as clicking its dot.
   *
   * `owner` matters: selecting one of your places opens it in the panel on the
   * right, which reads *your* library. Doing that for a friend's city would put
   * their name on a heading over your artists, and read "0 artists" for a city
   * only they have. So the caller is told whose row it was.
   */
  onSelectPlace: (qid: string, label: string, owner: Owner) => void
  /** Open an artist in the panel on the right. */
  onOpenArtist: (id: string) => void
  /**
   * Open one of their playlists in the panel on the right.
   *
   * Two ids, because one is not an address: a source id is the number *their*
   * file used, and yours has a playlist 4 as surely as theirs does.
   */
  onOpenFriendPlaylist: (friendId: number, sourceId: number, name: string) => void
  /**
   * The imported libraries to search alongside yours — every one on the globe.
   *
   * Empty means the scope control is not offered at all rather than offered and
   * disabled: there is nothing to compare against, so a three-way choice with
   * two dead options would be furniture.
   */
  friendIds: number[]
  /** Each library's hue, so a row is marked in the colour it wears on the map. */
  friendColourOf: (id: number) => string
  /** Each library's name, for the tooltip on that mark. */
  friendNameOf: (id: number) => string | null
  scope: SearchScope
  onScope: (next: SearchScope) => void
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

export function SearchPanel({
  text,
  onText,
  chips,
  onAdd,
  onToggle,
  onRemove,
  onClear,
  onSelectPlace,
  onOpenArtist,
  onOpenFriendPlaylist,
  friendIds,
  friendColourOf,
  friendNameOf,
  scope,
  onScope,
}: Props) {
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = useState(0)
  const [mode, setMode] = useState<Mode>('search')

  // The same query the route makes, built by the same function, so this reads
  // its result out of the cache rather than asking a second time. Restating the
  // key here instead would work right up until one of the two changed.
  const labelsFor = useQuery(labelsQuery(chips))
  const limits = labelsFor.data?.limits

  /**
   * Which chips are not in effect, reconciled against the chips on screen.
   *
   * `dropped` describes the request that produced it, so between changing the
   * filter and the answer landing it is one step stale. That does not matter for
   * the count — a number briefly wrong is invisible — but a *mark* is a claim
   * about a specific chip, and the wrong chip wearing it is worse than none
   * wearing it. Removing one shifts which of the rest fall past the cap, so a
   * stale set can be both complete and pointing at the wrong four.
   *
   * Hence both guards: nothing is marked while an answer is in flight, and what
   * is marked is intersected with the chips actually present.
   */
  const notApplied = useMemo(() => {
    if (labelsFor.isFetching || !limits?.dropped.length) return undefined
    const present = new Set(chips.map(chipTarget))
    return new Set(limits.dropped.filter((t) => present.has(t)))
  }, [labelsFor.isFetching, limits, chips])

  const q = text.trim()
  // Falls back the moment the friend goes away — removing an imported library
  // while its scope is selected would otherwise keep asking for a library that
  // is not there. The server answers 'mine' for an unknown friend either way;
  // this keeps the control and the answer agreeing.
  const effectiveScope: SearchScope = friendIds.length ? scope : 'mine'
  const results = useQuery({
    queryKey: ['search', q, effectiveScope, friendIds.join(',')],
    queryFn: () => api.search(q, effectiveScope, friendIds),
    // Without this the list empties between keystrokes and the rows jump.
    placeholderData: keepPreviousData,
  })

  // One array, so moving the cursor is arithmetic rather than a walk across
  // three lists that each know only their own length.
  const rows = useMemo<Row[]>(() => {
    const d = results.data
    if (!d) return []
    return [
      ...d.places.map(
        (p): Row => ({
          kind: 'place',
          id: p.qid,
          label: p.name,
          // The country, because a library with music from two Londons offers
          // you two identical rows otherwise.
          sub: [plural(p.artists, 'artist'), p.country_iso].filter(Boolean).join(' · '),
          owner: p.owner ?? 'mine',
          hit: p,
        })
      ),
      ...d.artists.map(
        (a): Row => ({
          kind: 'artist',
          id: a.spotify_id,
          label: a.name,
          sub: a.city ?? 'origin unknown',
          owner: a.owner ?? 'mine',
          friendId: a.friend_id,
          hit: a,
        })
      ),
      // Yours, and — since format 2 of a share file — theirs. The owner comes
      // off the row rather than being assumed: it decides whether this is a chip
      // for your globe or a list of somebody else's tracks to open.
      ...d.playlists.map(
        (s): Row => ({
          kind: 'playlist',
          id: String(s.id),
          label: s.name,
          sub: plural(s.imported, 'track'),
          owner: s.owner ?? 'mine',
          friendId: s.friend_id,
          hit: s,
        })
      ),
    ]
  }, [results.data])

  useEffect(() => setCursor(0), [q])
  // On mount as well as on a mode change, which is what keeps `/` working: the
  // hotkey opens the search tab, this component mounts, and the caret is already
  // in the field. Runs after the dock has focused its body, so it wins.
  useEffect(() => {
    if (mode === 'search') input.current?.focus()
  }, [mode])

  const applied = new Map(chips.map((c) => [chipTarget(c), c.mode]))
  const chipFor = (row: Row, mode: Chip['mode']): Chip => ({
    kind: row.kind as ChipKind,
    mode,
    id: row.id,
    label: row.label,
  })

  /**
   * What a row can actually do, which depends on whose library it is from.
   *
   * A chip narrows *your* globe, and an artist page reads *your* library — so
   * neither is available for a friend's row, because neither would mean what it
   * appears to mean. A friend's place is the exception: flying there is a
   * statement about the map rather than about a library, and their ring is
   * already drawn at that coordinate.
   *
   * The distinction is on the row rather than in a disabled control, so a row
   * that cannot be chipped never shows a + that does nothing.
   */
  /**
   * The cover for a row, where there is one to have.
   *
   * A place is a point on a map: nothing in the library is a picture *of* it,
   * and the country flag it might otherwise borrow would be a claim about an
   * artist's nationality that mappify is careful not to make. So the Places
   * group carries no column of empty squares — the groups are separate lists
   * and only the ones that can be illustrated are.
   */
  const artOf = (row: Row) => (row.kind === 'place' ? null : row.hit.image_url)

  const canChip = (row: Row) => row.owner === 'mine'
  // Their playlist is the one row of theirs with something behind it: a list of
  // tracks that play, where their artist has no page and their place is a
  // coordinate. Note the asymmetry it creates — your playlist opens nothing and
  // becomes a chip, theirs opens and cannot be chipped — which is not an
  // inconsistency but the same rule twice: a row does what it can mean.
  const canOpen = (row: Row) =>
    row.kind === 'place' ||
    (row.kind === 'artist' && row.owner === 'mine') ||
    (row.kind === 'playlist' && row.owner === 'theirs')

  const go = (row: Row) => {
    if (row.kind === 'place') onSelectPlace(row.id, row.label, row.owner)
    else if (row.kind === 'artist' && row.owner === 'mine') onOpenArtist(row.id)
    else if (row.kind === 'playlist' && row.owner === 'theirs' && row.friendId != null)
      onOpenFriendPlaylist(row.friendId, Number(row.id), row.label)
    else if (row.kind === 'playlist') onAdd(chipFor(row, 'include'))
  }

  const move = (delta: number) => {
    if (!rows.length) return
    const next = (cursor + delta + rows.length) % rows.length
    setCursor(next)
    list.current?.querySelector(`[data-row="${next}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const row = rows[cursor]
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // preventDefault, or the caret jumps to the ends of the text instead.
      e.preventDefault()
      move(e.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (e.key === 'Enter' && row) {
      e.preventDefault()
      // Going somewhere and filtering by it are different intentions, and both
      // are wanted often enough to deserve their own key.
      // The query survives adding a chip, exactly as it does when the + on a row
      // is clicked. One search usually answers more than one question — narrow
      // to this London, rule out the other one — and clearing the box after the
      // first would mean typing it again for the second.
      // A friend's row has nothing to narrow: chips filter your own globe, so
      // Enter falls back to going there rather than quietly doing nothing or,
      // worse, adding a chip that means something else.
      if (e.metaKey || e.ctrlKey || !canChip(row)) go(row)
      else onAdd(chipFor(row, e.shiftKey ? 'exclude' : 'include'))
      return
    }
    // The chip-input idiom everyone tries once and is disappointed to miss.
    if (e.key === 'Backspace' && !text && chips.length) {
      e.preventDefault()
      onRemove(chipTarget(chips[chips.length - 1]))
    }
  }

  const group = (kind: Row['kind'], title: string) => {
    const mine = rows.map((r, i) => [r, i] as const).filter(([r]) => r.kind === kind)
    if (!mine.length) return null
    return (
      <div className="search-group" key={kind}>
        <h2 className="search-group-head">{title}</h2>
        <ul className="search-rows" role="listbox" aria-label={title}>
          {mine.map(([row, i]) => {
            const target = chipTarget(row)
            const chipped = applied.get(target)
            const theirs = row.owner === 'theirs'
            return (
              <li
                // Keyed by owner *and* library as well as target: a city you
                // both have is two rows carrying the same chip target, and their
                // playlist ids are numbers local to their own file — two friends
                // both have a playlist 4, and so do you.
                key={`${row.owner}:${row.friendId ?? ''}:${target}`}
                id={`search-row-${i}`}
                data-row={i}
                role="option"
                aria-selected={i === cursor}
                className={`menu-row search-row${i === cursor ? ' at' : ''}${
                  theirs ? ' search-row-theirs' : ''
                }`}
                onMouseEnter={() => setCursor(i)}
              >
                <button
                  type="button"
                  className="search-go"
                  onClick={() => go(row)}
                  disabled={!canOpen(row)}
                >
                  {row.kind !== 'place' && <Thumb src={artOf(row)} />}
                  <span className="menu-name">
                    {theirs && (
                      <span
                        className="owner-dot"
                        // Its own library's colour, not a single overlay hue:
                        // with several searched at once the mark is the only
                        // thing saying which one a row came from. The same
                        // colour it wears on the globe, so it needs no legend.
                        style={{ color: row.friendId != null ? friendColourOf(row.friendId) : undefined }}
                        title={
                          row.friendId != null && friendNameOf(row.friendId)
                            ? `From ${friendNameOf(row.friendId)}'s library`
                            : 'From an imported library'
                        }
                        aria-hidden="true"
                      />
                    )}
                    {row.label}
                  </span>
                  <span className="menu-count">{row.sub}</span>
                </button>
                {canChip(row) && (
                  <ChipActions
                    label={row.label}
                    mode={chipped}
                    onPick={(pick) => onAdd(chipFor(row, pick))}
                    // chipTarget keys on kind and id, not on mode, so either
                    // button clears through the same target.
                    onClear={() => onRemove(chipTarget(chipFor(row, 'include')))}
                  />
                )}
              </li>
            )
          })}
        </ul>
      </div>
    )
  }

  return (
    <div className="dock-search" role="search" aria-label="Search and filter">
      {/* Three ways at the same act. Chips stay put underneath, because what you
          have already picked is true in every mode and moving it would read as
          having lost it. */}
      <div className="seg browse-modes" role="tablist" aria-label="How to pick a filter">
        {(
          [
            ['search', 'Search'],
            ['artists', 'Artists'],
            ['library', 'Library'],
          ] as [Mode, string][]
        ).map(([m, label]) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Offered only when there is a second library to search. With none
          imported this is not a disabled control, it is no control — two of the
          three options would be permanently dead and the row would be furniture. */}
      {mode === 'search' && friendIds.length > 0 && (
        <div className="seg scope-modes" role="group" aria-label="Which library to search">
          {(
            [
              ['mine', 'Mine'],
              // Not a name any more: 'theirs' is every library on the globe, and
              // one of their names on a button covering three would be wrong.
              ['theirs', 'Imported'],
              ['both', 'Both'],
            ] as [SearchScope, string][]
          ).map(([s, label]) => (
            <button
              key={s}
              aria-pressed={effectiveScope === s}
              onClick={() => onScope(s)}
              style={
                s !== 'mine' && effectiveScope === s
                  ? { background: friendColourOf(friendIds[0]) }
                  : undefined
              }
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {mode === 'search' && (
        <input
          ref={input}
          type="search"
          className="search-input"
          value={text}
          placeholder="artists, places, playlists"
          onChange={(e) => onText(e.target.value)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls="search-results"
          aria-activedescendant={rows[cursor] ? `search-row-${cursor}` : undefined}
        />
      )}

      <FilterChips
        chips={chips}
        onToggle={onToggle}
        onRemove={onRemove}
        onClear={onClear}
        dropped={notApplied}
      />

      {/* The globe can be obeying fewer filters than the link asks for: there is
          a cap per kind, because a place chip is a recursive walk. Saying so is
          the whole point — a URL listing forty filters over a globe using
          thirty-two, silently, is a wrong answer that looks like a right one.

          Gated on the marks rather than on the counts, and counting the marks
          themselves: this sentence points at them, so it must not be able to
          appear while they are suppressed, and its number must not be able to
          disagree with how many are on screen. */}
      {limits && notApplied?.size ? (
        <p className="panel-sub chips-capped" role="status">
          {limits.applied} of {limits.requested} filters applied. The {notApplied.size}{' '}
          marked above are being ignored — remove others to make room.
        </p>
      ) : null}

      {/* No standing line of instructions here. It changed with the mode and
          the query, so it read as a status even though it never was one, and
          every one of the four things it said is a caption on a control you can
          see: the + and − are on the rows, the chips are in front of you, and
          Enter does what the focused row's button does. */}

      <div id="search-results" ref={list}>
        {mode === 'artists' ? (
          <ArtistBrowser applied={applied} onAdd={onAdd} onRemove={onRemove} />
        ) : mode === 'library' ? (
          <LibraryBrowser applied={applied} onAdd={onAdd} onRemove={onRemove} />
        ) : (
          <>
            {group('place', 'Places')}
            {group('artist', 'Artists')}
            {/* "Your library" is the resting state's name for your own
                playlists. Under a scope that is not yours it is not your
                library, so it does not say so. */}
            {group('playlist', q || effectiveScope === 'theirs' ? 'Playlists' : 'Your library')}

            {/* Absent by design, not merely unmatched — and the difference is
                exactly what would otherwise make one control mean two things.
                The reason comes from the server, which knows why rather than
                guessing from an empty array. */}
            {results.data?.unavailable?.playlists && (
              <p className="panel-sub scope-note">{results.data.unavailable.playlists}</p>
            )}

            {q && !rows.length && !results.isFetching && (
              <p className="empty">
                {effectiveScope === 'theirs'
                  ? friendIds.length === 1
                    ? `Nothing in ${friendNameOf(friendIds[0]) ?? 'their'} library matches that.`
                    : 'Nothing in the imported libraries matches that.'
                  : effectiveScope === 'both'
                    ? 'Nothing in either library matches that.'
                    : 'Nothing in your library matches that.'}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
