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

export type SetupInfo = {
  /** Whether this browser has a session at all — everything else is per-user. */
  signedIn: boolean
  user: string | null
  /** No Spotify app registered yet: the first-run screen comes before sign-in. */
  needsClientId: boolean
  /** What Spotify must have on file, shown so it can be copied rather than typed. */
  redirectUri: string
  /** Your own machine, rather than someone's shared instance. */
  local: boolean
  spotify: { connected: boolean; stale?: boolean }
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
  total: number
  sample: { track: string; artist: string; city: string | null }[]
  places: string[]
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
async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'include' })
  if (res.status === 401) throw new NotSignedIn()
  if (!res.ok) throw new Error(`${res.status} ${path}`)
  const json = await res.json()
  if (json?.error) throw new Error(json.error)
  return json as T
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 401) throw new NotSignedIn()
  const json = await res.json()
  if (json?.error) throw new Error(json.error)
  return json as T
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
    /** Restrict to tracks from one library source. */
    source?: string | null
    limit?: number
  }) => {
    const sp = new URLSearchParams()
    if (params.q) sp.set('q', params.q)
    if (params.city) sp.set('city', params.city)
    if (params.country) sp.set('country', params.country)
    if (params.iso) sp.set('iso', params.iso)
    if (params.placeQid) sp.set('placeQid', params.placeQid)
    if (params.unknown) sp.set('unknown', '1')
    if (params.cityless) sp.set('cityless', '1')
    if (params.source) sp.set('source', params.source)
    sp.set('limit', String(params.limit ?? 60))
    return get<{ total: number; items: Artist[] }>(`/api/artists?${sp}`)
  },
  tree: (source?: string | null) =>
    get<{ countries: CountryNode[] }>(`/api/tree${source ? `?source=${source}` : ''}`),
  map: (source?: string | null) =>
    get<{ points: MapPoint[]; unmappedTracks: number }>(
      `/api/map${source ? `?source=${source}` : ''}`
    ),
  links: () => get<{ nesting: PlaceLink[]; collab: PlaceLink[] }>('/api/links'),
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
  setClientId: (clientId: string) =>
    post<{ clientId: string; redirectUri: string }>('/api/config/client-id', { clientId }),
  importStatus: () => get<ImportStatus>('/api/import/status'),
  startImport: () => get<ImportStatus>('/api/import'),
  cancelImport: () => get<{ cancelling: boolean }>('/api/import/cancel'),
  sources: () => get<{ sources: SourceRow[] }>('/api/sources'),
  playlistPreview: (scope: { placeQid?: string; iso?: string }) => {
    const sp = new URLSearchParams()
    if (scope.placeQid) sp.set("placeQid", scope.placeQid)
    if (scope.iso) sp.set("iso", scope.iso)
    return get<PlaylistPreview>(`/api/playlist-preview?${sp}`)
  },
  playlistCreate: (body: { placeQid?: string; iso?: string; name: string }) =>
    post<{ id: string; name: string; url: string | null; added: number }>('/api/playlist-create', body),
}
