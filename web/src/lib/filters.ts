import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from './api'

/**
 * The chips that narrow the globe.
 *
 * A chip is one clause of "show me this, not that". Includes AND across kinds
 * and OR within one — two playlists means either playlist, because the tracks
 * on both is nearly always nothing and is not what picking two of them means.
 * Excludes are the negation of the same union.
 *
 * They live in the URL rather than in component state, for the reason the
 * library filter already did: a narrowed globe should be a link you can send
 * someone. The typed query stays out of it — chips are a shape you have built,
 * text is a transient act of looking.
 */

export type ChipKind = 'artist' | 'playlist' | 'place'
export type ChipMode = 'include' | 'exclude'

export type Chip = {
  kind: ChipKind
  mode: ChipMode
  id: string
  /** For display only. Never sent to the server, never put in the URL. */
  label: string
}

/** What two chips having the same one means: the same thing, filtered twice. */
export const chipTarget = (c: Pick<Chip, 'kind' | 'id'>) => `${c.kind}:${c.id}`

const token = (c: Pick<Chip, 'kind' | 'id' | 'mode'>) =>
  `${c.mode === 'exclude' ? '-' : ''}${chipTarget(c)}`

const KINDS: ChipKind[] = ['artist', 'playlist', 'place']

/**
 * Labels, remembered for the length of the session.
 *
 * A chip made by clicking a search result knows its own name; one parsed out of
 * a shared link does not, and asks the server. Keeping the answers here is what
 * stops a chip flickering from `Q60` to `New York City` every time the URL is
 * re-parsed — which is every render that touches a search param.
 */
const labels = new Map<string, string>()

// Chips are parsed from the URL and memoised on it, so a label arriving later
// changes nothing on its own — the chip would sit there showing `Q60` until the
// next unrelated render. This is the store that says "names have changed"; the
// hook below subscribes, and re-derives when it fires.
let labelVersion = 0
const listeners = new Set<() => void>()
const subscribeLabels = (fn: () => void) => {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}
const labelSnapshot = () => labelVersion

export function rememberLabels(next: Record<string, string>) {
  let changed = false
  for (const [target, name] of Object.entries(next)) {
    if (labels.get(target) !== name) {
      labels.set(target, name)
      changed = true
    }
  }
  if (changed) {
    labelVersion++
    for (const fn of listeners) fn()
  }
  return changed
}

/**
 * Chips out of the URL, in canonical order.
 *
 * Sorted, and deliberately so. The same set of chips added in a different order
 * has to produce the same string, or every query key carrying it misses cache,
 * every view refetches, and the globe re-uploads every dot and arc for a filter
 * that did not actually change.
 */
export function parseChips(params: URLSearchParams): Chip[] {
  const raw = params.getAll('f')
  // `?source=` is what the old single-playlist dropdown wrote. Understood as an
  // included playlist so old links still work; Home rewrites the URL on sight,
  // so this only has to survive until every such link has been opened once.
  const legacy = params.get('source')
  const tokens = raw.length ? raw : legacy ? [`playlist:${legacy}`] : []

  const out: Chip[] = []
  const seen = new Set<string>()
  for (const t of tokens) {
    const mode: ChipMode = t.startsWith('-') ? 'exclude' : 'include'
    const body = mode === 'exclude' ? t.slice(1) : t
    const at = body.indexOf(':')
    if (at < 1) continue
    const kind = body.slice(0, at) as ChipKind
    const id = body.slice(at + 1)
    if (!KINDS.includes(kind) || !id) continue
    const target = `${kind}:${id}`
    if (seen.has(target)) continue
    seen.add(target)
    out.push({ kind, mode, id, label: labels.get(target) ?? id })
  }
  return sortChips(out)
}

/**
 * Includes before excludes, and it matters in a way alphabetical order does not.
 *
 * This comparator decides three things at once. Two are incidental — the cache
 * key, which only needs to be stable, and the order the chips appear in, which
 * only needs to be predictable. The third is not: the server fills each kind's
 * budget in the order it receives them, so whichever chips sort last are the
 * ones dropped when a kind is over its cap.
 *
 * Dropping an include and dropping an exclude are not equivalent. An include is
 * something you asked to see, and losing it takes places off the globe — which
 * looks like a library with no music there. An exclude is something you asked
 * not to see, and losing it puts something unwanted back on screen, where you
 * can see it and its chip is marked. So the cap should eat the excludes: err
 * towards showing what was asked for, and towards failing where it is visible.
 *
 * Spelled out rather than left to `localeCompare`, which gave the opposite
 * order by the accident of "exclude" preceding "include" in the alphabet.
 */
const MODE_ORDER: Record<ChipMode, number> = { include: 0, exclude: 1 }

const sortChips = (chips: Chip[]) =>
  [...chips].sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      MODE_ORDER[a.mode] - MODE_ORDER[b.mode] ||
      a.id.localeCompare(b.id)
  )

/** The `f` tokens, canonically ordered — the one string everything keys on. */
export const serialiseChips = (chips: Chip[]) => sortChips(chips).map(token)

/**
 * Add a chip, replacing any chip already aimed at the same thing.
 *
 * Including and excluding one place at once is always empty, so it is a bug
 * rather than an intention: asking to exclude something already included flips
 * it instead of contradicting it.
 */
export function addChip(chips: Chip[], next: Chip): Chip[] {
  labels.set(chipTarget(next), next.label)
  return sortChips([...chips.filter((c) => chipTarget(c) !== chipTarget(next)), next])
}

export const removeChip = (chips: Chip[], target: string) =>
  chips.filter((c) => chipTarget(c) !== target)

export const toggleChip = (chips: Chip[], target: string) =>
  chips.map((c) =>
    chipTarget(c) === target
      ? { ...c, mode: (c.mode === 'include' ? 'exclude' : 'include') as ChipMode }
      : c
  )

/**
 * The query that turns chips into names, and reports what the server did with
 * them.
 *
 * One function rather than the same three lines at each call site. Two places
 * read this — the route, for the labels, and the search panel, for the limits —
 * and they share a cache entry, so a key that drifts between them does not
 * break: it quietly becomes a second request for data already in hand. A silent
 * duplicate is a worse failure than a loud one, so there is exactly one
 * derivation of the key, the fetch and the condition.
 */
export const labelsQuery = (chips: Chip[]) => {
  const filters = serialiseChips(chips)
  return {
    queryKey: ['filter-labels', filters.join('&')],
    queryFn: () => api.filterLabels(filters),
    enabled: filters.length > 0,
  }
}

export function useFilters() {
  const [params, setParams] = useSearchParams()

  // Keyed on the serialised chips rather than on `params`, which is a new object
  // every render — so the chip array, and everything memoised from it, stays
  // referentially stable while the filter itself is unchanged.
  const key = params.getAll('f').join('&') || (params.get('source') ? `source=${params.get('source')}` : '')
  // Re-derives when the URL changes, and again when a name turns up for a chip
  // that arrived as a bare id.
  const version = useSyncExternalStore(subscribeLabels, labelSnapshot)
  const chips = useMemo(() => parseChips(params), [key, version]) // eslint-disable-line react-hooks/exhaustive-deps
  const filterKey = useMemo(() => serialiseChips(chips).join('&'), [chips])

  const write = useCallback(
    (next: Chip[]) => {
      const sp = new URLSearchParams(params)
      sp.delete('f')
      // The old param goes with the first write, so a link shared from here
      // carries the new shape.
      sp.delete('source')
      for (const t of serialiseChips(next)) sp.append('f', t)
      setParams(sp, { replace: true })
    },
    [params, setParams]
  )

  return {
    chips,
    filterKey,
    add: useCallback((c: Chip) => write(addChip(chips, c)), [chips, write]),
    remove: useCallback((target: string) => write(removeChip(chips, target)), [chips, write]),
    toggle: useCallback((target: string) => write(toggleChip(chips, target)), [chips, write]),
    clear: useCallback(() => write([]), [write]),
  }
}
