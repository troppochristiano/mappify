export type Artist = {
  spotify_id: string
  name: string
  artist_type: string | null
  status: string | null
  source: string | null
  fuzzy: number
  city: string | null
  country: string | null
  mb_country_iso: string | null
  mb_city: string | null
  mb_country: string | null
  wd_city: string | null
  wd_country: string | null
  place_qid: string | null
  tracks: number
  /** The artist's own portrait if there is one, else a cover from their tracks. */
  image_url: string | null
  /** 1 when the place was set by hand rather than derived from MusicBrainz. */
  origin_pinned?: number
  /** What placed this artist, when it was not MusicBrainz's begin-area. */
  origin_source?: 'you' | 'wikipedia' | null
}

export type PlaceHit = { qid: string; name: string; country_iso: string | null; artists: number }

/** A place as a search result: a PlaceHit that also knows how loud it is. */
export type PlaceResult = PlaceHit & { tracks: number }

/** An artist as a search result — the columns a row and a chip need, no more. */
export type ArtistHit = {
  spotify_id: string
  name: string
  city: string | null
  place_qid: string | null
  tracks: number
  image_url: string | null
}

/** A source as a search result. Narrower than SourceRow: a chip needs a name. */
export type PlaylistHit = {
  id: number
  kind: string
  name: string
  image_url: string | null
  imported: number
}

/**
 * Which libraries a search covers.
 *
 * 'theirs' means every imported library currently on the globe, not one of them
 * — there can be several, and a control naming one while the map shows three
 * would be lying. Without any, the server answers 'mine' rather than erroring,
 * so a link that outlives a removed library still works.
 */
export type SearchScope = 'mine' | 'theirs' | 'both'

/**
 * Which library a row came from.
 *
 * Present on every row, including your own. Labelling only the friend's side
 * would make yours identifiable by the *absence* of a field, which is a rule a
 * reader has to be told rather than one they can see.
 */
export type Owner = 'mine' | 'theirs'

export type SearchResults = {
  /** `friend_id` says *which* imported library, since 'theirs' can be several. */
  artists: (ArtistHit & { owner: Owner; friend_id?: number })[]
  places: (PlaceResult & { owner: Owner; friend_id?: number })[]
  /** Theirs since format 2 of a share file. `id` is local to that file. */
  playlists: (PlaylistHit & { owner?: Owner; friend_id?: number })[]
  scope: SearchScope
  friends: number[]
  /**
   * Kinds of result that cannot be here, with the reason — never merely absent.
   *
   * Distinct from "found nothing": an imported library from before playlists
   * travelled has none to search, and one that shared none has none either.
   * Saying which is the difference between a control that means two things in
   * two scopes and one that admits which it means. Silent once there are
   * playlists to match, when an empty list really is an empty search.
   */
  unavailable?: { playlists?: string }
}

export type FilterLabels = {
  labels: Record<string, string>
  targets: string[]
  /**
   * What the server did with the chips it was sent.
   *
   * `applied` can be less than `requested` — there is a per-kind cap, because a
   * place chip is a recursive walk of the settlement hierarchy and a hundred of
   * them is real work. When the two differ the panel has to say so: a URL
   * listing forty filters over a globe obeying thirty-two, with nothing on
   * screen admitting it, is the failure this field exists to prevent.
   *
   * `dropped` names the chips that did not make it, in URL order. `invalid` is
   * a different thing — tokens that were not chips at all, which only a
   * hand-written URL produces.
   */
  limits: { requested: number; applied: number; dropped: string[]; invalid: number }
}

export type PlaceTrack = {
  spotify_id: string
  name: string
  uri: string
  album: string | null
  artist: string
  city: string | null
}

export type Track = {
  spotify_id: string
  name: string
  album: string | null
  url: string | null
  position: number
  sources: string | null
}

export type Place = {
  place: string
  tracks: number
  artists: number
  iso: string | null
}

export type PlaceNode = {
  qid: string | null
  name: string
  tracks: number
  artists: number
  totalTracks: number
  totalArtists: number
  children: PlaceNode[]
  unresolved?: boolean
}

export type CountryNode = {
  iso: string | null
  name: string
  tracks: number
  artists: number
  children: PlaceNode[]
}


export type MapPoint = {
  qid: string
  name: string
  lat: number
  lon: number
  country_iso: string | null
  parent_qid: string | null
  tracks: number
  artists: number
}


/**
 * A string between two places on the globe.
 *
 * For a collaboration `tracks` says how many tracks the two share, and the two
 * ends are interchangeable. For a nesting link there is no count and `a` is the
 * child of `b`.
 */
export type PlaceLink = {
  a: string
  b: string
  alat: number
  alon: number
  blat: number
  blon: number
  tracks?: number
}

/**
 * What is behind one collaboration arc.
 *
 * An arc means "these two places are credited on the same track", so the thing
 * to show is the tracks — and on each, which artists came from which end. The
 * pair is unordered on the globe and stays unordered here; `a` and `b` are
 * whichever way round the click happened to name them.
 */
export type CollabTrack = {
  spotify_id: string
  name: string
  album: string | null
  uri: string | null
  url: string | null
  image_url: string | null
  /** Credited artists from either end, each tagged with the place they are from. */
  artists: { spotify_id: string; name: string; qid: string }[]
}

export type CollabDetail = {
  a: { qid: string; name: string; country_iso: string | null }
  b: { qid: string; name: string; country_iso: string | null }
  tracks: CollabTrack[]
  /** Distinct artists on each side, for the summary line. */
  artistCount: number
}

export type SetupInfo = {
  /** Whether this browser has a session at all — everything else is per-user. */
  signedIn: boolean
  user: string | null
  /** No Spotify app registered yet: the first-run screen comes before sign-in. */
  needsClientId: boolean
  /** The Spotify app in use, to check against the dashboard when sign-in fails. */
  clientId: string | null
  /** 'env' means .env owns it and the change control has to stay out of the way. */
  clientIdSource: 'stored' | 'env' | null
  /** What Spotify must have on file, shown so it can be copied rather than typed. */
  redirectUri: string
  /** Your own machine, rather than someone's shared instance. */
  local: boolean
  spotify: { connected: boolean; stale?: boolean; wrongApp?: boolean }
  index: { kind: string; artist_rows?: string; area_rows?: string; dump_version?: string }
  hasLibrary: boolean
}

export type ImportStatus = {
  running: boolean
  phase: string
  done: number
  total: number
  message: string | null
  /** Ticks whenever what the map draws has changed. Watch it, not `phase`. */
  revision?: number
  /** When the first dots became drawable — seconds in, not at the end. */
  mapReadyAt?: string | null
  summary?: {
    tracks: number; artists: number; playlists: number
    fromIndex: number; fromLive: number; unresolved: number
    skippedPlaylists?: { name: string; owner: string | null; tracks: number }[]
  } | null
}

export type SourceRow = {
  id: number; kind: string; name: string; image_url: string | null
  owned: number | null; note: string | null; track_total: number | null; imported: number
}

export type PlaylistPreview = {
  /** Yours plus every ticked library, counted as a set — a track you both have is one track. */
  total: number
  /** Of that, how many are your own. Zero at a place only an imported library has. */
  mine: number
  /** `who` names the library a track came from, and is null for your own. */
  sample: { track: string; artist: string; city: string | null; who: string | null }[]
  places: string[]
  /** The libraries `total` is of, echoed so a stale count is recognisable as one. */
  included: number[]
  /** Every imported library with something here, ticked or not. */
  shared: { id: number; name: string; tracks: number; missing: number }[]
}

export type Stats = {
  tracks: number
  artists: number
  trackRows: number
  withCity: number
  withCountry: number
  sources: { id: number; kind: string; name: string; track_total: number | null; last_synced_at: string | null }[]
}

/**
 * Thrown when the server has no session for us. Its own type so a caller can
 * tell "you are signed out" apart from "that request failed", and show the
 * sign-in screen rather than an error.
 */
export class NotSignedIn extends Error {
  constructor() {
    super('not signed in')
    this.name = 'NotSignedIn'
  }
}

// `credentials: 'include'` on every call, because the session lives in a cookie
// and in development the app and the API are on different ports — which makes
// every request cross-origin, and a cross-origin fetch sends no cookies unless
// asked. Without this the app is permanently signed out in dev and fine in
// production, which is the worst way to find out.
/**
 * Turns a dead server into a sentence somebody can act on.
 *
 * `fetch` rejects with a bare "TypeError: Failed to fetch" when there is nothing
 * listening — which is what a window left open after Mappify has stopped shows
 * on every click. The page is still on screen, so it looks like the app broke
 * rather than like it is simply no longer running.
 */
class NotRunning extends Error {
  constructor() {
    super('Mappify is not running any more — close this window and open Mappify again.')
    this.name = 'NotRunning'
  }
}

const send = async (path: string, init?: RequestInit) => {
  try {
    return await fetch(path, { credentials: 'include', ...init })
  } catch {
    // The only way fetch rejects here is a transport failure: same origin, no
    // CORS in play, so it means nothing is listening.
    throw new NotRunning()
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await send(path)
  if (res.status === 401) throw new NotSignedIn()
  if (!res.ok) throw new Error(`${res.status} ${path}`)
  const json = await res.json()
  if (json?.error) throw new Error(json.error)
  return json as T
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await send(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 401) throw new NotSignedIn()
  const json = await res.json()
  if (json?.error) throw new Error(json.error)
  return json as T
}

/** `?f=…&f=…`, or nothing at all when there are no chips. */
const filterQuery = (filters?: string[]) => {
  if (!filters?.length) return ''
  const sp = new URLSearchParams()
  for (const f of filters) sp.append('f', f)
  return `?${sp}`
}

export const api = {
  stats: () => get<Stats>('/api/stats'),
  artists: (params: {
    q?: string
    city?: string
    country?: string
    iso?: string
    placeQid?: string
    unknown?: boolean
    /** Known country, no town — pair with `iso`. */
    cityless?: boolean
    /** The filter chips, already serialised — see lib/filters.ts. */
    filters?: string[]
    limit?: number
    /** Where to resume. The endpoint has always taken it; nothing sent it until
     *  the artist picker needed to page past its 200-row ceiling. */
    offset?: number
  }) => {
    const sp = new URLSearchParams()
    if (params.q) sp.set('q', params.q)
    if (params.city) sp.set('city', params.city)
    if (params.country) sp.set('country', params.country)
    if (params.iso) sp.set('iso', params.iso)
    if (params.placeQid) sp.set('placeQid', params.placeQid)
    if (params.unknown) sp.set('unknown', '1')
    if (params.cityless) sp.set('cityless', '1')
    for (const f of params.filters ?? []) sp.append('f', f)
    sp.set('limit', String(params.limit ?? 60))
    if (params.offset) sp.set('offset', String(params.offset))
    return get<{ total: number; items: Artist[] }>(`/api/artists?${sp}`)
  },
  tree: (filters?: string[]) =>
    get<{ countries: CountryNode[] }>(`/api/tree${filterQuery(filters)}`),
  map: (filters?: string[]) =>
    get<{ points: MapPoint[]; unmappedTracks: number }>(`/api/map${filterQuery(filters)}`),
  /**
   * Everything you could turn into a chip, for one query.
   *
   * Not narrowed by the chips already applied: you are looking for the next
   * thing to include or rule out, and hiding candidates that fall outside the
   * current filter is how a filter becomes a cage. An empty query answers with
   * the library instead of with nothing.
   */
  search: (q: string, scope: SearchScope = 'mine', friends: number[] = []) => {
    const sp = new URLSearchParams({ q })
    // Omitted entirely in the default scope, so the common request is the same
    // URL it has always been and the cache key does not change under existing
    // callers. One repeated parameter per library, which the server also accepts
    // as a single id for the sake of older links.
    if (scope !== 'mine' && friends.length) {
      sp.set('scope', scope)
      for (const id of friends) sp.append('friend', String(id))
    }
    return get<SearchResults>(`/api/search?${sp}`)
  },
  /** The names behind chips that came out of a link rather than out of a click. */
  filterLabels: (filters: string[]) =>
    get<FilterLabels>(`/api/filter-labels${filterQuery(filters)}`),
  links: () => get<{ nesting: PlaceLink[]; collab: PlaceLink[] }>('/api/links'),
  /** What one collaboration arc is made of. The pair is unordered. */
  collab: (a: string, b: string) =>
    get<CollabDetail>(`/api/collab?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),
  placeSearch: (q: string) =>
    get<{ places: PlaceHit[] }>(`/api/place-search?q=${encodeURIComponent(q)}`),
  setArtistOrigin: (spotifyId: string, placeQid: string | null) =>
    post<{ ok?: boolean; error?: string }>('/api/artist-origin', { spotifyId, placeQid }),
  placeTrack: (qid: string) => get<PlaceTrack>(`/api/place-track?qid=${encodeURIComponent(qid)}`),
  artistTrack: (id: string) => get<PlaceTrack>(`/api/artist-track?id=${encodeURIComponent(id)}`),
  artist: (id: string) => get<{ artist: Artist; tracks: Track[] }>(`/api/artist?id=${encodeURIComponent(id)}`),
  places: (by: 'city' | 'country') => get<{ places: Place[] }>(`/api/places?by=${by}`),
  setup: () => get<SetupInfo>('/api/setup'),
  connect: () => get<{ authUrl: string }>('/api/auth/connect'),
  logout: () => get<{ signedIn: false }>('/api/auth/logout'),
  quit: () => get<{ stopping: boolean }>('/api/quit'),
  setClientId: (clientId: string, replace = false) =>
    post<{ clientId: string; redirectUri: string }>('/api/config/client-id', { clientId, replace }),
  importStatus: () => get<ImportStatus>('/api/import/status'),
  startImport: () => get<ImportStatus>('/api/import'),
  cancelImport: () => get<{ cancelling: boolean }>('/api/import/cancel'),
  sources: () => get<{ sources: SourceRow[] }>('/api/sources'),
  playlistPreview: (scope: { placeQid?: string; iso?: string; friends?: number[] }) => {
    const sp = new URLSearchParams()
    if (scope.placeQid) sp.set("placeQid", scope.placeQid)
    if (scope.iso) sp.set("iso", scope.iso)
    // Repeated rather than comma-joined, which is how every other route here
    // names more than one library.
    for (const id of scope.friends ?? []) sp.append('friend', String(id))
    return get<PlaylistPreview>(`/api/playlist-preview?${sp}`)
  },
  playlistCreate: (body: { placeQid?: string; iso?: string; name: string; friends?: number[] }) =>
    post<{ id: string; name: string; url: string | null; added: number }>('/api/playlist-create', body),
}
