// Talking to the sharing routes.
//
// Its own file rather than more of `api.ts` for two reasons. The first is that
// two of these calls cannot go through that file's helpers at all: `get<T>`
// calls `res.json()` and would choke on a gzip body, and `post` always
// `JSON.stringify`s, so neither can carry a file. The second is that a `.mappify`
// file is a different kind of thing from the rest of the API — untrusted, on
// disk, and written by somebody else — and keeping it in one place makes that
// visible.

export type Friend = {
  id: number
  spotify_id: string
  display_name: string
  format: number
  exported_at: string | null
  imported_at: string
  tracks: number
  artists: number
  places: number
  unplaced_tracks: number | null
  /** Rows the import refused. Shown rather than swallowed. */
  skipped_rows: number
  /** 0 or 1 — SQLite has no boolean. The bytes come from `avatarUrl`. */
  has_avatar: number
}

/** A friend's place, in the same shape the globe already draws. */
export type FriendPoint = {
  qid: string
  name: string
  country_iso: string | null
  lat: number
  lon: number
  tracks: number
  artists: number
}

export type SharedArtist = {
  id: string
  name: string
  image_url: string | null
  /** Tracks in your library, and in theirs. Never plays — there is no such data. */
  mine: number
  theirs: number
}

export type SharedPlace = {
  qid: string
  name: string
  country_iso: string | null
  lat: number | null
  lon: number | null
  mine: number
  theirs: number
}

export type TopPlace = {
  qid: string
  name: string
  country_iso: string | null
  tracks: number
}

export type LoneArtist = { id: string; name: string; tracks: number; image_url: string | null }

/**
 * Artists you have from a city they are already deep in — the one figure here
 * that needs the place graph, and so the one no other music-compare tool can
 * produce.
 */
export type Discovery = {
  qid: string
  name: string
  country_iso: string | null
  lat: number | null
  lon: number | null
  /** How many tracks they already have from this city. */
  theirTracks: number
  artists: LoneArtist[]
}

export type CompareReport = {
  /** The number on screen: a curve applied to `scores.artists`. Both are shown. */
  match: number
  band: 'faint' | 'some' | 'strong' | 'very strong' | 'near-identical'
  /** 'low' when either library is too small for the score to mean anything. */
  confidence: 'ok' | 'low'
  scores: { artists: number; places: number; countries: number; tracks: number }
  shared: {
    artists: number
    tracks: number
    places: number
    countries: number
    artistsOfSmaller: number
    tracksOfSmaller: number
  }
  size: {
    mine: { tracks: number; artists: number; places: number }
    theirs: { tracks: number; artists: number; places: number }
  }
  topSharedArtists: SharedArtist[]
  topSharedPlaces: SharedPlace[]
  myTopPlaces: TopPlace[]
  theirTopPlaces: TopPlace[]
  onlyMine: LoneArtist[]
  onlyTheirs: LoneArtist[]
  discoveries: Discovery[]
}

/** What the server said went wrong, rather than a status code. */
async function fail(res: Response): Promise<never> {
  let message = `${res.status}`
  try {
    const body = await res.json()
    if (body?.error) message = body.error
  } catch {
    // A non-JSON error body is not worth a second failure mode.
  }
  throw new Error(message)
}

const send = (path: string, init?: RequestInit) =>
  fetch(path, { credentials: 'include', ...init })

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await send(path, init)
  if (!res.ok) return fail(res)
  return (await res.json()) as T
}

export const friends = {
  list: () => json<{ friends: Friend[] }>('/api/friends'),

  one: (id: number) => json<{ friend: Friend; points: FriendPoint[] }>(`/api/friend?id=${id}`),

  compare: (id: number) =>
    json<{ friend: Friend; report: CompareReport }>(`/api/compare?friend=${id}`),

  remove: (id: number) =>
    json<{ ok: true }>('/api/friend-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }),

  /**
   * Send a `.mappify` file as the request body.
   *
   * Raw bytes rather than multipart: there is no multipart parser in this
   * codebase and writing one to move a single file would be a lot of surface
   * for no gain. The `File` goes straight down the wire.
   */
  import: (file: File) =>
    json<{ ok: true; friend: Friend; skipped: number }>('/api/friend-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    }),

  /**
   * The bytes of a friend's avatar, served from this origin.
   *
   * A URL rather than a data URI so the browser caches it once instead of
   * re-decoding base64 on every render, and so the list endpoint never has to
   * carry a hundred kilobytes per friend.
   */
  avatarUrl: (id: number) => `/api/friend-avatar?id=${id}`,

  /**
   * Write the export to disk and answer with where it went.
   *
   * For the downloaded app, whose window has no downloads bar to show a saved
   * file in — see `/api/export-file`. A hosted copy keeps `exportUrl` below,
   * where the browser's own download UI is present and is the right thing.
   */
  exportToFile: () => json<{ path: string }>('/api/export-file', { method: 'POST' }),

  /** Downloads rather than navigates, so the app is not unloaded. */
  exportUrl: () => '/api/export',
}

/**
 * The sentence under the big number.
 *
 * The score is real and low-looking on purpose — two unrelated libraries sit
 * near 0.08 and two people with genuinely shared taste land around 0.3 — so the
 * copy has to carry what the number cannot say on its own. Keyed off the band,
 * which comes from the raw cosine rather than the displayed percentage, so these
 * stay true even if the display curve is re-fitted.
 */
export const BAND_COPY: Record<CompareReport['band'], string> = {
  faint: 'Almost nothing in common — which is its own kind of interesting.',
  some: 'A handful of real overlaps. Most pairs of people land about here.',
  strong: 'Clearly the same corner of music. Well above a typical pair.',
  'very strong': 'You should be trading recommendations already.',
  'near-identical': 'Suspiciously close. Are you sure this is not your own file?',
}
