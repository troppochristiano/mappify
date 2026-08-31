import { useState, useEffect, useDeferredValue, useMemo, useCallback, useRef } from 'react'
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { api, type Artist, type PlaceLink, type PlaceTrack, type SearchScope } from '../lib/api'
import {
  Globe,
  DOT_MODES,
  rampAt,
  type DotMode,
  type FlyTarget,
} from '../components/Globe'
import { SpotifyPlayer, type NowPlaying } from '../components/SpotifyPlayer'
import { PlaceView, pathTo, nodeAt, type Crumb, type PlaceSelection } from '../components/PlaceView'
import { ArtistRow } from '../components/ArtistRow'
import { ArtistDetail } from '../components/ArtistDetail'
import { SetupPanel } from '../components/SetupPanel'
import { PlaylistBuilder } from '../components/PlaylistBuilder'
import { TunedReadout } from '../components/TunedReadout'
import { SearchPanel } from '../components/SearchPanel'
import { ComparePanel } from '../components/ComparePanel'
import { OverlayEye } from '../components/OverlayEye'
import { CollabPanel } from '../components/CollabPanel'
import { Dock, type DockTab } from '../components/Dock'
import { friends as friendsApi } from '../lib/friends'
import { FRIEND_COLOUR, FRIEND_COLOURS } from '../components/globe/layers'
import { useFilters, serialiseChips, rememberLabels, labelsQuery } from '../lib/filters'
import { useImportStatus } from '../lib/useImportStatus'
import { useFileDrop, SHARE_EXT } from '../lib/useFileDrop'
import { useHotkeys } from '../lib/useHotkeys'
import { countryBox } from '../components/globe/countryBox'

/**
 * How close the globe goes when you pick a single place.
 *
 * A city is a point, not a region, so it is given a fixed zoom rather than a
 * frame — there is no extent to fit. This is a target, not a floor: a floor
 * would mean where you end up depends on where you happened to have been, which
 * is precisely what made the camera feel unpredictable. Every city row is now
 * the same view of a different place, which is what a list of peers should be.
 *
 * 8 shows the city with the country around it. Note it is a zoom, so the ground
 * it covers narrows with latitude — Tromsø at 8 shows less of the map than
 * Nairobi does. That is how every web map behaves and matches what people
 * expect of a zoom level, so it is left alone rather than normalised.
 */
const CITY_ZOOM = 8

/**
 * What the dock covers, mirroring `--dock-w` and `--dock-edge` in styles.css.
 *
 * Duplicated from CSS for the reason the old panel width was: the camera has to
 * know how much of the map it cannot use, and there is no way to ask a
 * stylesheet that before the element exists.
 *
 * Two numbers rather than one because the dock covers two different shapes. Open
 * it routinely runs the height of the window, so what it takes is a column at
 * the left edge. Collapsed it is a head, a tab bar and the player — a strip in
 * the corner — and claiming a column there would push every country to the right
 * to clear something that is not in the way.
 */
const DOCK_INSET = 384 // --dock-w 360 + --dock-edge 12, twice
const DOCK_EDGE = 12 // --dock-edge

/**
 * Where a dock stops being a strip along the bottom and becomes a column at the
 * side, as a share of the window.
 *
 * One threshold rather than both insets at once: framePadding caps the two axes
 * against each other, so claiming a column *and* a strip frames a country into
 * whatever is left, which past a certain sheet height is nothing.
 */
const DOCK_TALL = 0.6

/** Below this the dock is edge to edge, so it is never a side column. Mirrors
 *  the `max-width: 780px` block in styles.css. */
const NARROW = 780

/**
 * A stable empty array for the links prop.
 *
 * `?? []` would be a new array on every render, and a fresh identity makes the
 * globe re-densify and re-upload every arc — so the literal is hoisted.
 */
const EMPTY_LINKS: PlaceLink[] = []

/** One object forever, so the arcs that need no markers never re-upload. */
const NO_ENDS: { lon: number; lat: number }[] = []

const COLLABS_KEY = 'mappify.collabs'

const AUTOPLAY_KEY = 'mappify.autoplay'

/**
 * The imported library that was loaded, and whether its rings were showing.
 *
 * In local storage rather than in the URL, for the reason the search scope is:
 * this is a row id in *this* machine's database, and it would name something
 * else — or nothing — in a link somebody else opened. The library itself has
 * been on disk all along; only the choice of which one to draw was being
 * forgotten every launch.
 */
const FRIEND_KEY = 'mappify.friend'
const FRIEND_VISIBLE_KEY = 'mappify.friendVisible'

const COLOURS_KEY = 'mappify.friendColours'

/**
 * The colour each imported library wears, migrating the single one this replaced.
 *
 * `mappify.friendColour` held one hue for the whole overlay. It was chosen while
 * some particular library was loaded, and that library's id is remembered too —
 * so the migration gives the colour back to the library it was actually about.
 * Spreading it across every library would put a deliberate choice on ones it was
 * never made for, and dropping it would lose it; this runs at most once per
 * browser either way.
 */
function readFriendColours(): Record<string, string> {
  let map: Record<string, string> = {}
  try {
    const raw = localStorage.getItem(COLOURS_KEY)
    if (raw) map = JSON.parse(raw) ?? {}
  } catch {
    /* unparseable is the same as unset: the colours are a preference, and one
       bad value must not be able to stop the app reading its own storage. */
  }
  const old = localStorage.getItem('mappify.friendColour')
  if (old === null) return map
  const was = readFriendId()
  if (was != null && map[was] === undefined) {
    map = { ...map, [was]: old }
    // Written here rather than left to the effect that persists this state.
    // StrictMode calls a state initialiser twice and keeps the *second* result:
    // with the old key already removed by the first call, the second would find
    // nothing to migrate and hand back a map without the colour — losing it on
    // the single load that existed to keep it. Saving first makes the whole
    // function idempotent, so a second run reads the migrated map straight back.
    localStorage.setItem(COLOURS_KEY, JSON.stringify(map))
  }
  localStorage.removeItem('mappify.friendColour')
  return map
}

/** The remembered library, if the stored value still looks like a row id. */
function readFriendId(): number | null {
  const raw = localStorage.getItem(FRIEND_KEY)
  if (raw === null) return null
  const id = Number(raw)
  // Guarded rather than trusted: anything else in there would otherwise be sent
  // to the API as NaN, which is a request for a friend that cannot exist.
  return Number.isInteger(id) && id > 0 ? id : null
}

/** How long the loader takes to fade out. Mirrors `.globe-loading--gone`. */
const LOADER_FADE = 320

/** The longest the loader may cover the map before it comes off regardless. */
const LOADER_MAX = 6000

/**
 * Whether the collaboration arcs start on, migrating the key this replaced.
 *
 * `mappify.linkMode` held one of three strings, and everybody who has ever run
 * mappify has one — `'nesting'` for almost all of them, since it was the
 * default. Reading it as a boolean would make every one of those strings
 * truthy, so every returning user would come back to arcs they never asked for.
 * Only `'collabs'` meant collabs; the old key is then dropped, so this runs at
 * most once per browser.
 */
function readCollabs(): boolean {
  const now = localStorage.getItem(COLLABS_KEY)
  if (now !== null) return now === '1'
  const was = localStorage.getItem('mappify.linkMode')
  if (was === null) return false
  localStorage.removeItem('mappify.linkMode')
  return was === 'collabs'
}

/** A view pushed on top of the dock's active tab. See `stack` below. */
type Push =
  | { kind: 'artist'; id: string }
  | { kind: 'collab'; a: string; b: string }
  | { kind: 'playlist' }

/**
 * The globe is the app. Search sits on top of it and filters the dots
 * themselves rather than opening a separate page.
 */
export function Home() {
  const [params, setParams] = useSearchParams()
  const selectedQid = params.get('place')
  const [text, setText] = useState('')
  const q = useDeferredValue(text)
  /**
   * The dock's section, and whether it is open.
   *
   * `tab` is never null: collapsed, the dock still says which section it will
   * come back to, which is what lets the collapse affordance be a chevron on a
   * named card rather than a mystery. The URL decides whether it starts open —
   * a link to a place is a link to reading about that place — and it is an
   * initialiser rather than an effect because an effect would flash a collapsed
   * dock and frame the camera against an inset that was about to change.
   */
  const [tab, setTab] = useState<DockTab>('places')
  const [dockOpen, setDockOpen] = useState(() =>
    ['place', 'iso', 'city', 'unknown', 'cityless'].some((k) => params.has(k))
  )

  /**
   * A pushed view: something you drilled into, rather than somewhere the tab bar
   * can take you.
   *
   * An artist, a collaboration arc and the playlist builder are all opened *from*
   * something — a row, a line on the globe, a button in the places tab — and
   * none of them is a destination in its own right. So they stack on top of the
   * active tab and are left by ← back, which means the tab bar underneath keeps
   * saying where you will be when you get out.
   */
  /**
   * How tall the dock is drawing itself, reported up from the drag.
   *
   * The camera is the only thing that needs it: a boolean cannot tell a sheet
   * pulled to the top of the window from the same sheet pulled halfway down,
   * and those cover different shapes of map.
   */
  const [dockH, setDockH] = useState(0)
  const onDockHeight = useCallback((px: number) => setDockH(px), [])

  /**
   * Whether the map has painted. Latched: it is about arriving, not about being
   * busy, so a filter change — which reuses the same map — must not put the
   * cover back over a globe you are already reading.
   */
  const [globeReady, setGlobeReady] = useState(false)
  const onGlobeReady = useCallback(() => setGlobeReady(true), [])

  /**
   * The map's own height, measured rather than taken from the window.
   *
   * They are the same number today — the globe is the whole page — but they are
   * different quantities, and the day anything sits above the map they part
   * company silently. The same argument the sheet-height comment in
   * framePadding makes, for the same reason.
   */
  const routeRef = useRef<HTMLDivElement>(null)
  const [route, setRoute] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = routeRef.current
    if (!el) return
    const read = () => setRoute({ w: el.clientWidth, h: el.clientHeight })
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /**
   * What the dock is covering, in the shape the camera can use.
   *
   * A tall dock on a wide screen is a column at the left. Anything else — a
   * short one, or any of them on a phone, where the sheet runs edge to edge —
   * is a strip along the bottom. Never both: framePadding caps the two axes
   * against each other, so claiming a column *and* a strip leaves a country
   * nothing to be framed into.
   */
  const dockTall = route.h > 0 && route.w > NARROW && dockH > route.h * DOCK_TALL
  const dockLeft = dockTall ? DOCK_INSET : 0
  const dockBottom = dockTall ? 0 : dockH + DOCK_EDGE * 2

  const [stack, setStack] = useState<Push[]>([])
  const pushed = stack[stack.length - 1] ?? null
  const push = (p: Push) => {
    setStack((s) => [...s, p])
    setDockOpen(true)
  }
  const pop = () => setStack((s) => s.slice(0, -1))

  /** Clicking the tab you are on collapses the dock; any other opens it. */
  const onTab = (t: DockTab) => {
    if (t === tab) return setDockOpen((o) => !o)
    setTab(t)
    setStack([])
    setDockOpen(true)
  }

  /** Artist whose details are open on top of the dock — never a route change. */
  const infoId = pushed?.kind === 'artist' ? pushed.id : null
  /** The collaboration arc being read, if one was clicked. */
  const collabPair = pushed?.kind === 'collab' ? pushed : null

  /**
   * The imported library being compared against, if any.
   *
   * Lifted out of the panel rather than kept inside it because the globe will
   * want it too — a friend's places draw as a second colour over your own — and
   * a selection that vanished every time the panel closed would take that
   * overlay with it.
   */
  const [friendId, setFriendId] = useState<number | null>(readFriendId)
  useEffect(() => {
    // Removed rather than written as null, so a stale id cannot outlive the
    // selection it described — which is also what the error effect below relies
    // on to forget a library that has since been deleted.
    if (friendId == null) localStorage.removeItem(FRIEND_KEY)
    else localStorage.setItem(FRIEND_KEY, String(friendId))
  }, [friendId])

  /**
   * A library dropped onto the window, rather than found through the picker.
   *
   * Handled at the route and not inside ComparePanel: the panel is mounted only
   * while its tab is open, and a file dragged onto the globe is the commonest
   * way this will ever be done. Success lands you on the comparison — the drop
   * said what you wanted, so making you then find the library in a list would be
   * asking twice.
   */
  const qc = useQueryClient()
  const [dropNote, setDropNote] = useState<string | null>(null)
  const dropImport = useMutation({
    mutationFn: friendsApi.import,
    onMutate: () => setDropNote(null),
    onSuccess: ({ friend, skipped }) => {
      qc.invalidateQueries({ queryKey: ['friends'] })
      setFriendId(friend.id)
      setTab('compare')
      setStack([])
      setDockOpen(true)
      setDropNote(
        skipped
          ? `${friend.display_name} imported — ${skipped} row${skipped === 1 ? '' : 's'} could not be read.`
          : null
      )
    },
    onError: (err: Error) => setDropNote(err.message),
  })
  // react-query keeps its mutate function stable, so the window listeners are
  // bound once rather than rebound on every render of the route.
  const { mutate: importDropped } = dropImport
  const onDrop = useCallback((file: File) => importDropped(file), [importDropped])
  const onWrongFile = useCallback(
    (name: string) => setDropNote(`${name} is not a ${SHARE_EXT} file.`),
    []
  )
  const dragging = useFileDrop(onDrop, onWrongFile)

  // Long enough to read once, and gone on its own: there is no room on the globe
  // for a message that needs dismissing.
  useEffect(() => {
    if (!dropNote) return
    const id = setTimeout(() => setDropNote(null), 6000)
    return () => clearTimeout(id)
  }, [dropNote])

  /** Their rings on or off, without forgetting which library is loaded. */
  const [friendVisible, setFriendVisible] = useState<boolean>(
    () => localStorage.getItem(FRIEND_VISIBLE_KEY) !== '0'
  )
  useEffect(() => {
    localStorage.setItem(FRIEND_VISIBLE_KEY, friendVisible ? '1' : '0')
  }, [friendVisible])

  /**
   * Which library the search sheet looks in.
   *
   * Deliberately not in the URL, unlike the chips. A chip is part of what the
   * globe is showing and belongs in a link somebody else can open; a scope names
   * an imported library by a local row id, which would mean something different
   * — or nothing — on anyone else's machine.
   */
  const [searchScope, setSearchScope] = useState<SearchScope>('mine')

  /**
   * A hue per imported library, rather than one for all of them.
   *
   * It used to be a single string, which quietly meant "the overlay colour" —
   * fine while one library was ever loaded, and wrong the moment there are
   * several: giving one of them a colour gave it to all of them, so the control
   * could not mean what it said.
   */
  const [friendColours, setFriendColours] = useState<Record<string, string>>(readFriendColours)
  useEffect(() => {
    localStorage.setItem(COLOURS_KEY, JSON.stringify(friendColours))
  }, [friendColours])

  const colourOf = useCallback(
    (id: number) =>
      // Defaulted from the palette by id, so two libraries differ before anyone
      // has chosen anything — which is the whole reason the colour is per
      // library. Stable, because the id is.
      friendColours[id] ?? FRIEND_COLOURS[id % FRIEND_COLOURS.length],
    [friendColours]
  )
  const setColour = useCallback(
    (id: number, colour: string) => setFriendColours((m) => ({ ...m, [id]: colour })),
    []
  )

  /** What the globe is actually drawing with: the loaded library's own hue. */
  const friendColour = friendId == null ? FRIEND_COLOUR : colourOf(friendId)

  const friendMap = useQuery({
    queryKey: ['friend-points', friendId],
    queryFn: () => friendsApi.one(friendId!),
    enabled: friendId != null,
  })

  // A remembered library that is not there any more. /api/friend answers "no
  // such friend" for an id that has been deleted, and without this the app would
  // come back holding it: no overlay, no explanation, and the compare tab
  // offering a detail view of something that is gone.
  useEffect(() => {
    if (friendMap.isError) setFriendId(null)
  }, [friendMap.isError])

  const friendPoints = useMemo(() => {
    if (!friendVisible || friendId == null) return undefined
    // parent_qid is null and stays null: an imported library is a flat list of
    // places with no containment tree, so there is no hierarchy to claim.
    return friendMap.data?.points.map((p) => ({ ...p, parent_qid: null }))
  }, [friendVisible, friendId, friendMap.data])

  // Containment is always drawn now, so the only thing left to decide is the
  // collaboration arcs. Off by default: they are a question you go asking, and
  // a first view of your own library should be the library.
  const [collabs, setCollabs] = useState<boolean>(readCollabs)
  useEffect(() => {
    localStorage.setItem(COLLABS_KEY, collabs ? '1' : '0')
  }, [collabs])

  // Turning the arcs off takes the arc panel with them. It is a panel about one
  // line on the globe, so leaving it open over a globe that no longer draws that
  // line would be a reading of something that is not there.
  useEffect(() => {
    if (!collabs) setStack((s) => s.filter((x) => x.kind !== 'collab'))
  }, [collabs])

  // Colour by default: a first view of a library should say which places carry
  // it, and the size ramp reads as "a scatter of dots" until you have found the
  // legend. Only affects a browser that has never picked one.
  const [dotMode, setDotMode] = useState<DotMode>(
    () => (localStorage.getItem('mappify.dotMode') as DotMode) || 'colour'
  )
  useEffect(() => {
    localStorage.setItem('mappify.dotMode', dotMode)
  }, [dotMode])

  // Whether a track starts playing on its own when you pick one. On unless it
  // has been turned off — the initialiser reads the *absence* of the key as on,
  // rather than testing for '1', which would default everyone to off.
  const [autoplay, setAutoplay] = useState<boolean>(
    () => localStorage.getItem(AUTOPLAY_KEY) !== '0'
  )
  useEffect(() => {
    localStorage.setItem(AUTOPLAY_KEY, autoplay ? '1' : '0')
  }, [autoplay])

  // Which part of the library the whole view is showing. In the URL so a
  // filtered globe is a link you can send someone — which is why the chips
  // that replaced the old single-playlist dropdown live there too.
  const { chips, filterKey, add, remove, toggle, clear } = useFilters()
  const filters = useMemo(() => serialiseChips(chips), [filterKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // An old ?source= link is understood on arrival (see parseChips) and rewritten
  // to the chip form here, so re-sharing it carries the shape everything else
  // speaks. One pass: after this the param is gone.
  useEffect(() => {
    if (!params.get('source')) return
    const next = new URLSearchParams(params)
    next.delete('source')
    for (const f of filters) next.append('f', f)
    setParams(next, { replace: true })
  }, [params, filters, setParams])

  // The names behind chips that arrived as bare ids in a link. Chips made by
  // clicking a result already know theirs, so this usually resolves nothing.
  const labels = useQuery(labelsQuery(chips))
  useEffect(() => {
    if (labels.data?.labels) rememberLabels(labels.data.labels)
  }, [labels.data])

  // keepPreviousData on both: an import refreshes these every ~25 seconds as it
  // resolves more artists, and without it the globe would blink empty each time.
  // It does the same job for the chips — a filter that changes should redraw the
  // globe, not empty it and fill it again.
  const map = useQuery({
    queryKey: ['map', filterKey],
    queryFn: () => api.map(filters),
    placeholderData: keepPreviousData,
  })
  // Always loaded, not just while browsing: a dot click needs the tree to work
  // out its ancestry for the breadcrumbs.
  const tree = useQuery({
    queryKey: ['tree', filterKey],
    queryFn: () => api.tree(filters),
    placeholderData: keepPreviousData,
  })

  // The cover over the black stage, and its removal a beat later. Unmounting it
  // on the same tick as the class would cut rather than fade; the timer is the
  // fade's own length, kept next to it.
  // A tab that is not being looked at does not paint, and a map that never
  // paints never idles — so in a background tab the cover would sit over a globe
  // that is finished and merely unwatched. The globe itself is mounted and
  // correct throughout; this only promises that the cover always comes off.
  useEffect(() => {
    if (!map.data || globeReady) return
    const id = setTimeout(() => setGlobeReady(true), LOADER_MAX)
    return () => clearTimeout(id)
  }, [map.data, globeReady])

  const loading = !map.data || !globeReady
  const [loaderGone, setLoaderGone] = useState(false)

  // The import that may be running behind the map. react-query dedupes on the
  // shared key, so watching it here costs no extra polling.
  const job = useImportStatus().data
  // Nothing drawn yet — either the library is empty or nothing has resolved.
  const noPoints = (map.data?.points.length ?? 0) === 0

  /**
   * Where the import card has been dragged to, as an offset from centre.
   *
   * An offset rather than a position, so the card stays centred if the window is
   * resized and only moves by however far it was pushed. Kept for the session
   * only: it exists to get the card off whatever it is covering right now, and a
   * position remembered from last week would put it somewhere with no reason.
   */
  const [importNudge, setImportNudge] = useState({ x: 0, y: 0 })
  const dragImport = (e: React.PointerEvent<HTMLDivElement>) => {
    // Left button only, and never from a drag that began on the progress bar.
    if (e.button !== 0) return
    const startX = e.clientX
    const startY = e.clientY
    const from = importNudge
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) =>
      setImportNudge({ x: from.x + ev.clientX - startX, y: from.y + ev.clientY - startY })
    const up = () => {
      el.releasePointerCapture(e.pointerId)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
  useEffect(() => {
    if (loading) return
    const id = setTimeout(() => setLoaderGone(true), LOADER_FADE)
    return () => clearTimeout(id)
  }, [loading])
  // Both relations arrive together, and both are drawn — the toggle only
  // decides whether the collaborations are among them.
  const links = useQuery({ queryKey: ['links'], queryFn: api.links })

  // Read here rather than in App: the floating header that used to ask for
  // these is gone, and the options tab is the only thing that shows them now.
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const nestLinks = links.data?.nesting ?? EMPTY_LINKS
  const collabLinks = collabs ? links.data?.collab ?? EMPTY_LINKS : EMPTY_LINKS

  // Typed text lights dots; chips remove them. Two different acts, and this is
  // the first — so it runs *within* the chips rather than instead of them.
  const matches = useQuery({
    queryKey: ['artists', 'globe', q, filterKey],
    queryFn: () => api.artists({ q, filters, limit: 200 }),
    enabled: q.trim().length > 0,
    placeholderData: keepPreviousData,
  })

  // Through a sorted string first, so two keystrokes that light the same places
  // produce the same Set *object*. The globe bakes lit-ness into its GeoJSON —
  // a dimmed dot has to lose its label as well as its colour — so a new Set
  // identity means re-uploading every dot on the planet.
  const litKey = useMemo(() => {
    if (!q.trim() || !matches.data) return null
    return matches.data.items
      .map((a) => a.place_qid)
      .filter(Boolean)
      .sort()
      .join(',')
  }, [q, matches.data])
  const litQids = useMemo(
    () => (litKey == null ? null : new Set(litKey ? litKey.split(',') : [])),
    [litKey]
  )

  const selected = map.data?.points.find((p) => p.qid === selectedQid) ?? null

  // A selection is not always a dot: it can be a whole country, a city the map
  // has no coordinates for, or the Unknown bucket. All four open the same panel.
  const isoFilter = params.get('iso')
  const cityFilter = params.get('city')
  const unknownFilter = params.get('unknown') === '1'
  const citylessFilter = params.get('cityless') === '1'
  const hasFilter = Boolean(
    selectedQid || isoFilter || cityFilter || unknownFilter || citylessFilter
  )
  const regionName = (iso: string) =>
    new Intl.DisplayNames(['en'], { type: 'region' }).of(iso) ?? iso
  const filterLabel =
    selected?.name ??
    params.get('label') ??
    cityFilter ??
    (citylessFilter ? (isoFilter ? 'City unknown' : 'No known origin') : null) ??
    (unknownFilter ? 'Unknown origin' : null) ??
    (isoFilter ? regionName(isoFilter) : null) ??
    'Selection'

  const artists = useQuery({
    queryKey: ['artists', 'filter', selectedQid, isoFilter, cityFilter, unknownFilter, citylessFilter, filterKey],
    queryFn: () =>
      api.artists({
        placeQid: selectedQid ?? undefined,
        iso: isoFilter ?? undefined,
        city: cityFilter ?? undefined,
        unknown: unknownFilter || undefined,
        cityless: citylessFilter || undefined,
        filters,
        limit: 200,
      }),
    enabled: hasFilter,
  })

  const track = useQuery({
    queryKey: ['place-track', selectedQid],
    queryFn: () => api.placeTrack(selectedQid!),
    enabled: Boolean(selectedQid),
    // The previous place's track rather than undefined while the next one is in
    // flight, so `source` below never dips to null between two real tracks.
    placeholderData: keepPreviousData,
  })

  // A track picked by hand (an artist or a song in the results) wins over the
  // place's random pick, until the place changes and re-tunes.
  const [manual, setManual] = useState<PlaceTrack | null>(null)

  const source = manual ?? track.data ?? null
  const nowPlaying: NowPlaying = source?.uri
    ? {
        uri: source.uri,
        name: source.name,
        artist: source.artist,
        place: (manual ? source.city : selected?.name ?? source.city) ?? '',
      }
    : null

  const playArtist = async (a: Artist) => {
    const t = await api.artistTrack(a.spotify_id)
    if (t?.uri) setManual(t)
  }

  // Tuning to a different place hands playback back to that place. Driven off
  // the selection itself rather than the click handler, so browser back/forward
  // and deep links behave the same as clicking a dot.
  useEffect(() => {
    setManual(null)
    setStack([])
  }, [selectedQid])

  const [flyTo, setFlyTo] = useState<FlyTarget | null>(null)
  /** Whatever the cursor is over on the globe — never a selection. */
  // The hovered place lives in TunedReadout, not here — see the note there. The
  // route only holds the wire to it, so onHover can be an identity that never
  // changes and never re-renders anything above the readout itself.
  const tunedSetter = useRef<((qid: string | null) => void) | null>(null)
  const registerTuned = useCallback((set: ((qid: string | null) => void) | null) => {
    tunedSetter.current = set
  }, [])
  const onHover = useCallback((qid: string | null) => tunedSetter.current?.(qid), [])
  /** Whatever the cursor is over in the place menu, lit on the globe. */
  const [menuHover, setMenuHover] = useState<PlaceSelection | null>(null)

  /**
   * Leaving the places panel drops the selection and nothing else.
   *
   * Deliberately does not touch the camera: where you have flown to is your
   * business, and yanking the globe back out to the whole world every time a
   * panel closes throws away the view you went to the trouble of finding. What
   * closing restores is the *unselected* state — no place singled out, every
   * label back in play.
   */
  const close = () => {
    const next = new URLSearchParams(params)
    for (const k of ['place', 'iso', 'city', 'unknown', 'cityless', 'label']) next.delete(k)
    // Hovering a row spotlights its dots and quietens every other label. React
    // does not fire mouseleave when an element unmounts, so closing the panel
    // with the pointer resting on a row left that spotlight on with no row left
    // to leave — the globe stayed dimmed and half its names stayed hidden.
    setMenuHover(null)
    setParams(next, { replace: true })
  }

  useHotkeys({
    onSlash: () => {
      setTab('search')
      setDockOpen(true)
    },
    // One ladder, most-recently-opened first, so Escape means "back out of this"
    // rather than "close everything". A pushed view is more recent than the tab
    // under it, and the tab is more recent than a selection made before either —
    // so Escape walks out the way you walked in. Note what it does *not* do:
    // collapsing the dock keeps the chips. Silently unfiltering the globe
    // because a card went away would be a destructive act with no visible cause.
    onEscape: () => {
      if (stack.length) pop()
      else if (dockOpen) setDockOpen(false)
      else if (hasFilter) close()
    },
  })

  /**
   * The box to frame for a country.
   *
   * Its borders, not its music. Framing the bbox of the places you happen to
   * have was the old behaviour and it is why hovering Italy showed you a few
   * cities rather than Italy — one artist from Palermo and one from Milan
   * framed the whole peninsula, two from Milan framed Lombardy.
   *
   * countryBox works from the country's own polygons and drops distant
   * territories, so the United States is the lower 48 rather than a frame
   * stretched to the Aleutians. The old data-derived box stays as the fallback
   * for the three territories the topology has no code for.
   */
  const countryFrame = useCallback(
    (iso: string): FlyTarget | null => {
      const box = countryBox(iso)
      if (box) return { kind: 'fit', bounds: box }

      const pts = (map.data?.points ?? []).filter((p) => p.country_iso === iso)
      if (!pts.length) return null
      const lats = pts.map((p) => p.lat)
      const lons = pts.map((p) => p.lon)
      // A country holding a single place has no box to fit, so it is given a
      // little room around the point rather than a zero-width one.
      const pad = pts.length > 1 ? 0 : 0.5
      return {
        kind: 'fit',
        bounds: [
          [Math.min(...lons) - pad, Math.min(...lats) - pad],
          [Math.max(...lons) + pad, Math.max(...lats) + pad],
        ],
      }
    },
    [map.data]
  )

  /**
   * Hovering a menu row lights the matching dots. A country covers many dots,
   * so this is a set rather than one id — hovering "Italy" shows you the whole
   * spread at once.
   */
  /**
   * Which dots are spotlit, as a stable string.
   *
   * Two things ask for a spotlight and they do not stack. A menu hover is
   * transient — it lasts as long as the cursor rests on a row — while an arc
   * selection persists, so the hover is always the more recent question and
   * takes the globe for its duration. The arc does not go dark meanwhile: it
   * stays lit by feature-state and its ends by their own layer, neither of which
   * this touches. Same precedence as the country outline, which resolves
   * menu-over-globe for the same reason.
   *
   * Null means "nothing asked, light everything". An empty string means "asked,
   * and legitimately matches nothing", which dims the whole globe — right only
   * when something else is carrying the answer, as it is for the eleven arcs
   * whose ends are both dotless. No branch meaning "nothing asked" may return it.
   *
   * A string first, then the Set, for the reason litKey exists: a new Set
   * identity re-uploads every dot on the planet, so an unchanged spotlight has
   * to yield the same object.
   */
  const spotKey = useMemo(() => {
    if (menuHover) {
      if (menuHover.kind === 'place') return menuHover.qid
      if (menuHover.kind === 'country' && menuHover.iso) {
        return (map.data?.points ?? [])
          .filter((p) => p.country_iso === menuHover.iso)
          .map((p) => p.qid)
          .sort()
          .join(',')
      }
      return null
    }
    // Deliberately not reading map.data, so a chip refetch cannot churn the
    // spotlight while an arc is open.
    if (collabPair) return [collabPair.a, collabPair.b].sort().join(',')
    return null
  }, [menuHover, collabPair, map.data])

  const highlight = useMemo(
    () => (spotKey == null ? null : new Set(spotKey ? spotKey.split(',') : [])),
    [spotKey]
  )

  /**
   * The ends of the selected arc that have no dot right now.
   *
   * From the link row rather than from /api/collab, which does not carry
   * coordinates and would be a round trip besides — these are the exact
   * coordinates the arc was drawn from, in the same render the panel opens, so
   * the marker and the dimming arrive together instead of the globe greying out
   * and then growing its ends a moment later.
   *
   * `alon`/`blon`, never the arc's own vertices: greatCircle unwraps longitudes
   * past ±180 to keep the line continuous across the antimeridian, and a point
   * at 181° is not a place.
   *
   * Recomputed against the current dots rather than frozen at click time, so a
   * chip that removes an end's dot grows a marker for it instead of leaving a
   * lit arc ending in nothing.
   */
  const collabEnds = useMemo(() => {
    if (!collabPair || !collabs) return NO_ENDS
    const { a, b } = collabPair
    const row = (links.data?.collab ?? []).find(
      (l) => (l.a === a && l.b === b) || (l.a === b && l.b === a)
    )
    if (!row) return NO_ENDS
    const have = new Set((map.data?.points ?? []).map((p) => p.qid))
    const out: { lon: number; lat: number }[] = []
    if (!have.has(row.a)) out.push({ lon: row.alon, lat: row.alat })
    if (!have.has(row.b)) out.push({ lon: row.blon, lat: row.blat })
    return out.length ? out : NO_ENDS
  }, [collabPair, collabs, links.data, map.data])

  /**
   * The country to outline, which is a different question from which dots to
   * light: hovering a city row means "show me where Manchester is", and drawing
   * the United Kingdom around it is the answer that places it.
   *
   * A place with no country — the handful mappify could not resolve — outlines
   * nothing rather than guessing.
   */
  const highlightIso = useMemo(() => {
    if (!menuHover) return null
    switch (menuHover.kind) {
      case 'country':
      // "Somewhere in the United States" names a country as surely as the
      // country row does, and is the row most helped by being shown one.
      case 'cityless':
        return menuHover.iso ?? null
      case 'place':
        return map.data?.points.find((p) => p.qid === menuHover.qid)?.country_iso ?? null
      // A city row groups every place of that name wherever it is, and unknown
      // is the places with no country at all. Neither has one country to draw.
      default:
        return null
    }
  }, [menuHover, map.data])

  /**
   * Hovering a row also turns the globe to it — but only after a short pause.
   * Without the delay, running the cursor down the country list would spin the
   * globe once per row.
   *
   * Hover and a click now ask for the same view, differing only by that pause.
   * They used to differ by a held-back zoom, which meant clicking the row you
   * were already hovering nudged the camera again for no reason anyone could
   * see.
   */
  useEffect(() => {
    if (!menuHover) return
    const timer = window.setTimeout(() => {
      // 'cityless' is "somewhere in the United States" — it names a country as
      // surely as a country row does, and already outlines one.
      if ((menuHover.kind === 'country' || menuHover.kind === 'cityless') && menuHover.iso) {
        const frame = countryFrame(menuHover.iso)
        if (frame) {
          setFlyTo({ ...frame, key: `hover:${menuHover.iso}` })
        }
      } else if (menuHover.kind === 'place') {
        const point = map.data?.points.find((p) => p.qid === menuHover.qid)
        if (point) {
          setFlyTo({
            kind: 'point',
            lat: point.lat,
            lon: point.lon,
            zoom: CITY_ZOOM,
            key: `hover:${menuHover.qid}`,
          })
        }
      }
    }, 220)
    return () => window.clearTimeout(timer)
  }, [menuHover, countryFrame, map.data])

  const infoArtist =
    matches.data?.items.find((a) => a.spotify_id === infoId) ??
    artists.data?.items.find((a) => a.spotify_id === infoId) ??
    null

  /**
   * Every level selects something, including Unknown — an artist with no known
   * origin is still a row you should be able to open. The URL is the single
   * source of truth, so a dot click and a menu click are the same event.
   */
  const onNavigate = (s: PlaceSelection) => {
    // Picking a place is a new intent, exactly as opening an artist is. Left
    // set, the arc's spotlight would outlive it — and the newly selected dot
    // would keep its white fill (selection outranks dim) while silently losing
    // its name, because the labels layer filters on dim.
    setStack([])
    const next = new URLSearchParams(params)
    for (const k of ['place', 'iso', 'city', 'unknown', 'cityless']) next.delete(k)

    if (s.kind === 'place') {
      const point = map.data?.points.find((p) => p.qid === s.qid)
      // A floor, not a framing: if you have already zoomed past this, picking a
      // dot just centres it and leaves your zoom alone.
      if (point)
        setFlyTo({ kind: 'point', lat: point.lat, lon: point.lon, zoom: CITY_ZOOM, key: s.qid })
      next.set('place', s.qid)
    } else if (s.kind === 'country' && s.iso) {
      const frame = countryFrame(s.iso)
      if (frame) setFlyTo({ ...frame, key: s.iso })
      next.set('iso', s.iso)
    }
    else if (s.kind === 'city') next.set('city', s.city)
    else if (s.kind === 'cityless') {
      // Carries the country as well, so the trail can lead back up to it.
      next.set('cityless', '1')
      if (s.iso) next.set('iso', s.iso)
    } else if (s.kind === 'unknown') next.set('unknown', '1')
    // 'root' clears everything, which the deletes above already did.
    // Same reason as in close(): the row you clicked is about to be replaced by
    // the level below it, and an unmounted row never fires mouseleave.
    setMenuHover(null)
    setParams(next, { replace: true })
    setTab('places')
    setDockOpen(true)
  }

  /**
   * Clicking a dot is the same navigation as clicking its row, so it is the same
   * call. The two used to be separate: the menu flew the globe to the place and
   * zoomed in, while a dot click only rewrote the URL and left the camera where
   * it was — so the two routes to the same place behaved differently. Going
   * through onNavigate means they cannot drift apart again.
   */
  const select = (qid: string) => {
    const point = map.data?.points.find((p) => p.qid === qid)
    onNavigate({ kind: 'place', qid, label: point?.name ?? 'Place' })
  }

  const countries = tree.data?.countries ?? []

  /** Where you are, worked out from the URL rather than remembered separately. */
  const crumbs: Crumb[] = useMemo(() => {
    const root: Crumb = { label: 'World', select: { kind: 'root' } }
    if (selectedQid) {
      const found = pathTo(countries, selectedQid)
      if (found) return [root, ...found]
      return [root, { label: selected?.name ?? 'Place', select: { kind: 'place', qid: selectedQid, label: selected?.name ?? 'Place' } }]
    }
    // Checked before the country, because a cityless selection carries an iso of
    // its own and would otherwise read as "the whole country".
    if (citylessFilter) {
      const c = countries.find((x) => x.iso === isoFilter)
      const country: Crumb[] = isoFilter
        ? [{ label: c?.name ?? isoFilter, select: { kind: 'country', iso: isoFilter, label: c?.name ?? isoFilter } }]
        : []
      return [root, ...country, { label: filterLabel, select: { kind: 'cityless', iso: isoFilter, label: filterLabel } }]
    }
    if (isoFilter) {
      const c = countries.find((x) => x.iso === isoFilter)
      return [root, { label: c?.name ?? isoFilter, select: { kind: 'country', iso: isoFilter, label: c?.name ?? isoFilter } }]
    }
    if (unknownFilter) return [root, { label: 'Unknown', select: { kind: 'unknown', label: 'Unknown' } }]
    if (cityFilter) return [root, { label: cityFilter, select: { kind: 'city', city: cityFilter, label: cityFilter } }]
    return [root]
  }, [countries, selectedQid, isoFilter, cityFilter, unknownFilter, citylessFilter, filterLabel, selected?.name])

  /** What sits inside the current level. */
  const nested = useMemo(() => {
    const toRow = (n: {
      qid: string | null
      name: string
      totalTracks: number
      children: unknown[]
      city?: string | null
      iso?: string | null
      cityless?: boolean
    }) => ({
      key: n.qid ?? (n.cityless ? `cityless:${n.iso ?? 'ZZ'}` : `city:${n.name}`),
      label: n.name,
      count: n.totalTracks,
      drillable: n.children.length > 0,
      // A row selects by what the server says it is, never by its label — that
      // is what left "Unknown city" opening onto nothing.
      select: (n.qid
        ? { kind: 'place', qid: n.qid, label: n.name }
        : n.cityless
          ? { kind: 'cityless', iso: n.iso ?? null, label: n.name }
          : { kind: 'city', city: n.city ?? n.name, label: n.name }) as PlaceSelection,
    })
    if (selectedQid) return (nodeAt(countries, selectedQid)?.children ?? []).map(toRow)
    // Before the iso branch: a cityless selection is a leaf, not a country.
    if (unknownFilter || cityFilter || citylessFilter) return []
    if (isoFilter) return (countries.find((c) => c.iso === isoFilter)?.children ?? []).map(toRow)
    return countries.map((c) => ({
      key: c.iso ?? 'ZZ',
      label: c.name,
      count: c.tracks,
      drillable: c.children.length > 0,
      select: (c.name === 'Unknown'
        ? { kind: 'unknown', label: 'Unknown' }
        : { kind: 'country', iso: c.iso, label: c.name }) as PlaceSelection,
    }))
  }, [countries, selectedQid, isoFilter, cityFilter, unknownFilter, citylessFilter])

  /**
   * What the dock head says.
   *
   * A pushed view wins over the tab under it. The rule for what goes here rather
   * than in the body: the head carries a label the dock knows the moment it
   * opens, so it never has to say nothing while a fetch lands. An artist is the
   * exception — the route already has the name from the list you clicked.
   */
  const dockTitle = pushed
    ? pushed.kind === 'artist'
      ? infoArtist?.name ?? 'Artist'
      : pushed.kind === 'collab'
        ? 'Collaboration'
        : 'New playlist'
    : tab === 'places'
      ? hasFilter
        ? filterLabel
        : 'Places'
      : tab === 'search'
        ? 'Search'
        : tab === 'compare'
          ? 'Compare'
          : 'Options'

  const dockBody = pushed ? (
    pushed.kind === 'artist' ? (
      <ArtistDetail id={pushed.id} onPlay={setManual} nowPlayingUri={nowPlaying?.uri ?? null} />
    ) : pushed.kind === 'collab' ? (
      <CollabPanel
        a={pushed.a}
        b={pushed.b}
        // Pushed on top rather than replacing the arc: an artist opened from a
        // collaboration is a step further in, and ← back is the way out of it.
        onOpenArtist={(id) => push({ kind: 'artist', id })}
        onPlay={setManual}
        nowPlayingUri={nowPlaying?.uri ?? null}
      />
    ) : (
      <PlaylistBuilder
        placeQid={selectedQid ?? undefined}
        iso={isoFilter ?? undefined}
        placeName={filterLabel}
      />
    )
  ) : tab === 'search' ? (
    /* Search, and the filters built from it. It reads the same globe the places
       tab does, so a chip added here narrows what that tab lists. */
    <SearchPanel
      text={text}
      onText={setText}
      chips={chips}
      onAdd={add}
      onToggle={toggle}
      onRemove={remove}
      onClear={clear}
      onSelectPlace={(qid, label, owner) => {
        // A friend's city turns the globe to it and stops there. Selecting it
        // would open the places tab, which reads your own library — their name
        // over your artists, and "0 artists" for a city only they have. Flown to
        // by *their* coordinates, since it may be a place your own library has
        // never resolved.
        if (owner === 'theirs') {
          const p = friendMap.data?.points.find((x) => x.qid === qid)
          if (p) {
            setFlyTo({ kind: 'point', lat: p.lat, lon: p.lon, zoom: CITY_ZOOM, key: `friend:${qid}` })
          }
          return
        }
        onNavigate({ kind: 'place', qid, label })
      }}
      onOpenArtist={(id) => push({ kind: 'artist', id })}
      friendId={friendId}
      friendName={friendMap.data?.friend.display_name ?? null}
      friendColour={friendColour}
      scope={searchScope}
      onScope={setSearchScope}
    />
  ) : tab === 'compare' ? (
    <ComparePanel
      selectedFriend={friendId}
      onSelectFriend={setFriendId}
      visible={friendVisible}
      onVisible={setFriendVisible}
      colourOf={colourOf}
      onColour={setColour}
    />
  ) : tab === 'options' ? (
    /* How the globe draws itself, and what it draws from. Not destinations like
       the other tabs — these are the things you set once and leave, which is
       exactly what a tab you have to open is for. Connect and import used to be
       a tab of their own next to this one; they are the same kind of visit, and
       one page saves guessing which of the two owned re-importing. */
    <div className="dock-options">
      <section>
        <h2>Dots</h2>
        <div className="seg" role="group" aria-label="Dot encoding">
          {DOT_MODES.map((m) => (
            <button key={m.id} aria-pressed={dotMode === m.id} onClick={() => setDotMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
      </section>
      <section>
        <h2>Collaboration arcs</h2>
        {/* Containment has no control: it is always drawn. It is the shape of
            the library rather than a finding about it, and without it the dots
            read as an unsorted scatter. */}
        <div className="seg" role="group" aria-label="Collaboration arcs">
          <button aria-pressed={collabs} onClick={() => setCollabs(true)}>
            on
          </button>
          <button aria-pressed={!collabs} onClick={() => setCollabs(false)}>
            off
          </button>
        </div>
      </section>
      <section>
        <h2>Autoplay</h2>
        {/* Off does not mean silence: the track you picked is still loaded and
            named in the player, waiting on its own play button. Said here
            because a toggle called autoplay could as easily mean "never touch
            the player", and the two behave differently the moment you click a
            song. */}
        <p className="panel-sub">Off loads the track paused instead of starting it.</p>
        <div className="seg" role="group" aria-label="Autoplay">
          <button aria-pressed={autoplay} onClick={() => setAutoplay(true)}>
            on
          </button>
          <button aria-pressed={!autoplay} onClick={() => setAutoplay(false)}>
            off
          </button>
        </div>
      </section>
      {/* The counts the floating header used to carry. They belong with the
          other things about the view rather than over the map. */}
      <section className="dock-stats">
        <h2>This library</h2>
        <dl>
          <div>
            <dt>tracks</dt>
            <dd>{stats.data?.tracks ?? '—'}</dd>
          </div>
          <div>
            <dt>artists</dt>
            <dd>{stats.data?.artists ?? '—'}</dd>
          </div>
          {/* Two different numbers, so both, named for what they each are: one
              counts rows with no country at all, the other counts tracks the
              map could find nowhere to put. */}
          <div>
            <dt>unknown origin</dt>
            <dd>{stats.data ? stats.data.trackRows - stats.data.withCountry : '—'}</dd>
          </div>
          <div>
            <dt>no mappable origin</dt>
            <dd>{map.data?.unmappedTracks ?? '—'}</dd>
          </div>
        </dl>
      </section>
      {/* Directly under the counts, so the summary the last import printed reads
          as the run that produced them rather than as a second, disagreeing set
          of numbers. */}
      <SetupPanel />
    </div>
  ) : (
    /* One view for browsing and for a selected place. A dot click and a walk
       through the menu both set the URL, and this reads only from that, so they
       cannot diverge. */
    <PlaceView
      crumbs={crumbs}
      nested={nested}
      onNavigate={onNavigate}
      onHoverRow={setMenuHover}
      subtitle={
        hasFilter ? (
          <>
            {selected
              ? `${selected.tracks} tracks · ${selected.artists} artists`
              : `${artists.data?.total ?? 0} artists`}
            <br />
            <span style={{ color: 'var(--dim)' }}>
              {unknownFilter
                ? 'No origin recorded in MusicBrainz or Wikidata for these.'
                : 'Bands are placed where they formed; solo artists where they were born.'}
            </span>
          </>
        ) : null
      }
      actions={
        <>
          {/* The rings are a property of the globe, and this is the tab you are
              on while looking at it — so the switch for them lives here too,
              rather than only in the panel you had to visit to turn them on. */}
          {friendMap.data?.friend && (
            <div className="overlay-mini">
              <OverlayEye
                visible={friendVisible}
                colour={friendColour}
                label={
                  friendVisible
                    ? `Hide ${friendMap.data.friend.display_name}'s places on the globe`
                    : `Show ${friendMap.data.friend.display_name}'s places on the globe`
                }
                onClick={() => setFriendVisible(!friendVisible)}
              />
              <span>{friendMap.data.friend.display_name}</span>
            </div>
          )}
          {/* Any selection that resolves to tracks can become a playlist — a
              whole country as readily as one city. It sits above the artists so
              it is reachable without scrolling past 200 rows. */}
          {hasFilter && (selectedQid || isoFilter) ? (
            <button
              className="primary"
              style={{ marginBottom: 14 }}
              onClick={() => push({ kind: 'playlist' })}
            >
              Make a {filterLabel} playlist
            </button>
          ) : null}
        </>
      }
      body={
        hasFilter ? (
          <>
            <h2 style={{ marginTop: 14 }}>Artists</h2>
            <ul className="artist-list">
              {artists.data?.items.map((a) => (
                <ArtistRow
                  key={a.spotify_id}
                  artist={a}
                  onPlayArtist={playArtist}
                  onPlayTrack={setManual}
                  onInfo={(id) => push({ kind: 'artist', id })}
                  showPlace={a.city !== selected?.name}
                  nowPlayingUri={nowPlaying?.uri ?? null}
                />
              ))}
            </ul>
          </>
        ) : null
      }
    />
  )

  return (
    <div className="globe-route" ref={routeRef}>
      {map.data && (
        <Globe
          points={map.data.points}
          litQids={litQids}
          friendPoints={friendPoints}
          friendColour={friendColour}
          selectedQid={selectedQid}
          onSelect={select}
          onHover={onHover}
          flyTo={flyTo}
          dotMode={dotMode}
          links={collabLinks}
          nestLinks={nestLinks}
          collabs={collabs}
          highlight={highlight}
          highlightIso={highlightIso}
          onSelectLink={(a, b) => push({ kind: 'collab', a, b })}
          linkEnds={collabEnds}
          selectedLink={collabPair ? `${collabPair.a}~${collabPair.b}` : null}
          // Two shapes, one card — see DOCK_TALL.
          obscuredLeft={dockLeft}
          obscuredRight={0}
          obscuredBottom={dockBottom}
          onReady={onGlobeReady}
        />
      )}

      {/* Two waits, one cover: the library has to arrive before there is a globe
          to build, and the globe then has to paint. Told apart in the wording,
          because the first is the slow one on a cold start and "loading the
          globe" over a request for the library would be a lie about what is
          taking the time. Left mounted for the length of the fade so the map is
          uncovered rather than revealed by a cut. */}
      {!loaderGone && (
        <div
          className={`globe-loading${loading ? '' : ' globe-loading--gone'}`}
          role="status"
          aria-live="polite"
        >
          <span className="spinner" aria-hidden="true" />
          <span>{map.data ? 'Drawing the globe…' : 'Loading your library…'}</span>
        </div>
      )}

      {/* The second wait, and the only one that can run for twenty minutes.
          Deliberately not a cover like the one above it: the globe fills in
          while the import works — the first dots land seconds after the first
          placeable artist — and hiding that behind a curtain would hide the
          best thing the app does. It waits for the globe's own loader to finish
          fading so there are never two spinners.

          It leaves before the job does. `origins-live` is the tail that looks
          up whatever the bundled index could not match, at the one request a
          second MusicBrainz asks for, and on a large library that is an hour of
          a spinner sitting over a map that is already drawn and already worth
          looking at. The work carries on; the options tab still reports it.

          Unless there is nothing on the map yet. A download whose index failed
          to ship resolves *every* artist that way, so the tail is the whole
          import — and hiding the only sign of life for ten minutes over an
          empty globe is how a working app comes to look broken. That happened. */}
      {job?.running && loaderGone && (job.phase !== 'origins-live' || noPoints) && (
        <div
          className="import-loading"
          role="status"
          aria-live="polite"
          onPointerDown={dragImport}
          style={
            importNudge.x || importNudge.y
              ? { transform: `translate(calc(-50% + ${importNudge.x}px), calc(-50% + ${importNudge.y}px))`, animation: 'none' }
              : undefined
          }
        >
          <span className="spinner" aria-hidden="true" />
          <div className="import-loading-text">
            <b>Importing your library…</b>
            <span>{job.message ?? job.phase}</span>
            {job.total > 0 && (
              <div className="bar">
                <span style={{ width: `${Math.round((job.done / job.total) * 100)}%` }} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Only while something is actually being dragged over the window. A
          permanent "drop a file here" target would be a sign on the globe
          advertising a feature nobody is using at the time. */}
      {dragging && (
        <div className="drop-veil" role="presentation">
          <div className="drop-veil-card">
            <b>Drop to add this library</b>
            <span>A {SHARE_EXT} file exported from someone else's Mappify.</span>
          </div>
        </div>
      )}

      {/* What came of it — a refused file, or an import that lost rows. Silence
          on success is deliberate: the comparison opening is the confirmation. */}
      {(dropNote || dropImport.isPending) && (
        <div className="drop-note" role="status" aria-live="polite">
          {dropImport.isPending ? 'Reading the library…' : dropNote}
        </div>
      )}

      {/* Colour needs a key to be readable at all; size does not. */}
      {dotMode === 'colour' && map.data && (
        <div className="legend">
          <span>1</span>
          <i
            style={{
              background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1]
                .map((t) => `rgb(${rampAt(t).join(',')})`)
                .join(', ')})`,
            }}
          />
          <span>{Math.max(...map.data.points.map((p) => p.tracks))}</span>
          <em>tracks</em>
        </div>
      )}

      {/* No reticle: dots are clicked directly and hover shows a pointer, so a
          fixed crosshair was decoration that also blocked the view. Hovering
          still names the place under the cursor. */}
      {/* Shown even with a place selected: hovering to identify neighbouring
          dots is exactly what you do while the dock is open. */}
      {map.data && (
        <TunedReadout
          points={map.data.points}
          selectedQid={selectedQid}
          register={registerTuned}
        />
      )}

      {/* Everything the app can show, and what is playing, as one column in the
          corner. The dock grows upward off the player rather than either being
          pinned to an edge of its own — see .dock-stack. */}
      <div className="dock-stack">
        <Dock
          tab={tab}
          open={dockOpen}
          onTab={onTab}
          onSelect={setTab}
          onOpenChange={setDockOpen}
          onHeight={onDockHeight}
          onBack={pushed ? pop : undefined}
          title={dockTitle}
          badges={{ search: chips.length }}
        >
          {dockBody}
        </Dock>
        <SpotifyPlayer track={nowPlaying} autoplay={autoplay} />
      </div>
    </div>
  )
}
