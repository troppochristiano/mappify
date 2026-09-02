import { useEffect, useMemo, useRef } from 'react'
import {
  LngLat,
  Map as MapLibreMap,
  setWorkerUrl,
  type GeoJSONSource,
  type MapGeoJSONFeature,
  type Point as ScreenPoint,
  type PointLike,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import type { MapPoint, Owner, PlaceLink } from '../lib/api'
import { coastlines, dotsToGeoJSON, friendsToGeoJSON, linksToGeoJSON } from './globe/geo'
import type { FriendLib } from './globe/geo'
import {
  LAYER,
  SOURCE,
  applyDotMode,
  applyLinkQuiet,
  buildStyle,
  countryFilter,
} from './globe/layers'
import type { DotMode } from './globe/ramp'

/**
 * Tell MapLibre where its worker is, rather than letting it work it out.
 *
 * MapLibre resolves the worker as a sibling file of its own module, which no
 * bundler can follow: the reference is built at runtime, so Rollup never emits
 * the file and the request falls through to index.html. The symptom is a planet
 * that renders perfectly with nothing on it — only the GeoJSON sources are
 * parsed in the worker, so the imagery is fine while every dot, label and link
 * silently fails to appear, with one MIME-type warning as the only clue.
 *
 * `?worker&url` makes the bundler own it: the worker and the chunk it imports
 * are built as their own graph and the URL points at the real emitted asset, in
 * development and in production alike.
 */
setWorkerUrl(maplibreWorkerUrl)

export { DOT_MODES, rampAt } from './globe/ramp'
export type { DotMode } from './globe/ramp'

type Props = {
  points: MapPoint[]
  /** Dots matching the active search stay lit; the rest dim. Null = no filter. */
  litQids: Set<string> | null
  /**
   * The imported libraries being drawn, in the order they should stack.
   *
   * Several at once, each with its own colour, all from one source: circle paint
   * is data-driven, so a library costs features rather than a layer — and one
   * label layer is the only way names from two libraries can compete on track
   * count rather than on which was added first.
   */
  friends?: FriendLib[]
  selectedQid: string | null
  /** Only ever a deliberate click — dragging the globe never selects. */
  onSelect: (qid: string, owner: Owner) => void
  /**
   * A collaboration arc was clicked: the two places it joins.
   *
   * Only ever fires in `collabs` mode. A nesting arc says "this is inside that",
   * which is a fact the breadcrumbs already carry and which has nothing behind
   * it to read — so those highlight on hover but are not clickable.
   */
  onSelectLink?: (a: string, b: string) => void
  /** The arc being read about, drawn lit. `${a}~${b}`, as the source promotes. */
  selectedLink?: string | null
  /**
   * Ends of the selected arc that have no dot of their own, drawn as markers so
   * the arc does not terminate in nothing. Usually empty, and usually the same
   * empty array — see NO_ENDS in the route.
   */
  linkEnds?: { lon: number; lat: number }[]
  /** Whatever the cursor is over, for the floating name readout. */
  onHover: (qid: string | null) => void
  /**
   * Rotate the globe here. Not a MapPoint, because a country has no dot of its
   * own — it is flown to by the centroid of the places inside it.
   */
  flyTo: FlyTarget | null
  /** How magnitude is encoded: dot area, or colour at a fixed size. */
  dotMode: DotMode
  /** Who recorded with whom. Drawn, and clickable, only when `collabs`. */
  links: PlaceLink[]
  /** Containment. Always drawn, never clickable — it is the shape, not a find. */
  nestLinks: PlaceLink[]
  /** Whether the collaboration arcs are on. */
  collabs: boolean
  /**
   * Lit from outside the canvas — hovering a row in the place menu highlights
   * the same dots as hovering them on the globe.
   */
  highlight?: Set<string> | null
  /**
   * Outline this country. Set from the place menu; a dot hovered on the globe
   * highlights its own country without being told to.
   */
  highlightIso?: string | null
  /**
   * Pixels of chrome covering the right edge of the map.
   *
   * Framing centres a country in what is *visible*, not in the viewport, or
   * every country you hover lands underneath the card you are reading.
   *
   * Nothing sits on the right any more — the dock took both edges into one
   * corner — but the arithmetic below caps the two sides against each other, so
   * the side stays in the API rather than being folded away.
   */
  obscuredRight?: number
  /** The same, on the left — an open dock. */
  obscuredLeft?: number
  /** The same, along the bottom — a collapsed dock and the player under it. */
  obscuredBottom?: number
  /**
   * Called once, when the map has painted rather than merely parsed.
   *
   * The route covers the globe with a loader until this fires, and `style.load`
   * is too early for that: the style is up, no tile has arrived, and lifting the
   * cover there would show a black sphere for the second the imagery takes. The
   * first `idle` is the map saying it has nothing left to draw.
   */
  onReady?: () => void
}

/**
 * Where to send the globe.
 *
 * Two kinds, because they differ in who works out the centre. A `fit` is handed
 * a box and lets the camera solve for both the centre and the zoom — and that
 * pair has to come from the same solve. On a globe the apparent size of the
 * planet is `worldSize / (2π·cos(centre latitude))`, so a zoom computed for one
 * centre and applied at another is not merely offset, it is the wrong scale, and
 * wrong by more the further apart the two latitudes are. A `point` names its own
 * centre and its own zoom, so the question never arises.
 *
 * There is deliberately no floor any more. A floor is what made this feel
 * broken: where you ended up depended on where you happened to have been, so the
 * same country framed differently depending on your history.
 */
export type FlyTarget =
  | {
      kind: 'fit'
      /** `[[west, south], [east, north]]`; west may exceed east across the antimeridian. */
      bounds: [[number, number], [number, number]]
      /** Stop closing in past this, so a city-state does not land on rooftops. */
      maxZoom?: number
      key?: string
    }
  | { kind: 'point'; lat: number; lon: number; zoom: number; key?: string }

/** Where the tile pyramid built by `tools/build-earth-tiles.mjs` stops. */
const EARTH_MAXZOOM = 5

/**
 * The zoom at which the planet fills the window.
 *
 * MapLibre's zoom describes a flat world of `512 * 2^z` pixels; wrapped onto a
 * globe that world becomes a sphere whose diameter on screen is that width over
 * π. So the zoom that makes the planet as wide as the shorter side of the window
 * is a matter of solving for it, not of guessing a number — and it has to be
 * solved again on resize, or the globe fills a laptop screen and swims in a
 * maximised one. The old canvas globe encoded the same 0.91 margin as the 2.2 in
 * its projection scale.
 */
function fillZoom(map: MapLibreMap) {
  const el = map.getContainer()
  const d = Math.min(el.clientWidth, el.clientHeight) * 0.91
  // A container with no size has no fill zoom, and null says so. The arithmetic
  // would otherwise answer -Infinity — log2(0) — which is not a zoom but does
  // look like one until setMinZoom refuses it, several frames later and inside
  // an event handler. A map can reach zero size while perfectly alive: display:
  // none on an ancestor, or a route transition collapsing the element, both of
  // which fire the resize this is wired to.
  if (!(d > 0)) return null
  return Math.log2((d * Math.PI) / 512)
}

/**
 * How far past the fill the globe may be pulled back.
 *
 * A little, so the planet can be seen whole with space around it, but not so far
 * that it becomes a marble in a black field.
 */
const ZOOM_OUT_ROOM = 0.35

/**
 * The zoom at which the planet fills the window, at a given centre latitude.
 *
 * `fillZoom` solves for a globe of diameter `worldSize / π`, which is only its
 * size when the centre is on the equator. Nearer a pole the projection draws it
 * `1 / cos(latitude)` larger — at 60° it is twice the size — so a floor derived
 * from `fillZoom` alone sits about a level too high up there, and a country like
 * Norway or Russia gets clamped short of the zoom that would have fitted it.
 *
 * Clamped at 75° because cos runs to zero at the pole and the room would grow
 * without limit; cos 75° is about a quarter, which is 1.9 levels of extra room
 * and already more than anywhere with music in it needs.
 */
function fillZoomAt(map: MapLibreMap, lat: number) {
  const fill = fillZoom(map)
  if (fill == null) return null
  const capped = Math.min(Math.abs(lat), 75)
  return fill + Math.log2(Math.cos((capped * Math.PI) / 180))
}

/** The floor, for wherever the camera is or is about to be. */
function applyMinZoom(map: MapLibreMap, lat = map.getCenter().lat) {
  const floor = fillZoomAt(map, lat)
  // Nothing to frame, so nothing to say about how far back you may pull. The
  // resize that gives the container a size calls this again.
  if (floor == null) return
  // -2 is MapLibre's own lower bound; going under it throws. Nothing should
  // reach it now that the zero-size case is handled, which is exactly when a
  // backstop is cheap.
  map.setMinZoom(Math.max(-2, floor - ZOOM_OUT_ROOM))
}

/**
 * How close a country is allowed to be framed.
 *
 * Fitting Singapore or Monaco exactly would put you on rooftops, which says
 * nothing about where the place is. This is the point where a frame stops being
 * a frame and starts being a street map.
 */
const COUNTRY_MAX_ZOOM = 9

/**
 * Room to leave around a fitted box.
 *
 * Proportional rather than a fixed 90px, so the same country is framed the same
 * way in a small window as a large one. The three `obscured*` numbers are the
 * chrome covering the map — the dock, and the player under it — so that a
 * country ends up centred in what you can actually see rather than behind the
 * list you are reading.
 *
 * They are taken at face value. This used to guess: it knew the sheet was 62vh
 * below 780px and 68vh below 420px, and hard-coded all four numbers out of the
 * stylesheet. It cannot know that any more — the dock is a sheet you drag, so
 * its height is whatever you left it at — and it no longer has to, because the
 * dock measures itself and the caller reports what it actually covers.
 *
 * Both axes are capped at 80% of the space they eat into, because padding that
 * leaves no room does not degrade gracefully: MapLibre's globe fit reads a
 * property off the mercator pass's result without checking it, so the failure is
 * a TypeError thrown from inside the library rather than a value you can test
 * for. Verified — `left + right > width` throws exactly that.
 */
function framePadding(
  map: MapLibreMap,
  obscuredLeft: number,
  obscuredRight: number,
  obscuredBottom: number
) {
  const el = map.getContainer()
  const w = el.clientWidth
  const h = el.clientHeight
  const base = Math.max(40, Math.min(w, h) * 0.08)

  const left = Math.min(base + obscuredLeft, w * 0.4)
  const right = Math.max(0, Math.min(base + obscuredRight, w * 0.8 - left))
  const top = Math.min(base, h * 0.4)
  const bottom = Math.max(0, Math.min(base + obscuredBottom, h * 0.8 - top))

  return { top, bottom, left, right }
}

/**
 * The satellite imagery the globe hands over to on the way in.
 *
 * Esri's World Imagery, because it is the one worldwide service that serves
 * plain `{z}/{y}/{x}` tiles with no key and no account — anything else would put
 * a signup between mappify and its own globe. Note the order: ArcGIS puts *row*
 * before column, which is the opposite of every other tile URL here.
 *
 * Swappable without touching this file, because a provider is a thing that
 * changes: `VITE_SAT_TILES` takes any XYZ template — Mapbox, Bing, a paid Esri
 * key, a local cache — and the literal `off` puts the globe back on Blue Marble
 * alone, which is also what happens on its own when the network is gone.
 */
const DETAIL_TILES =
  import.meta.env.VITE_SAT_TILES ??
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

/**
 * How deep that imagery is asked to go.
 *
 * World Imagery is served to z19 in most of the world and to z17 or so in the
 * rest; asking past what exists for a place gets 4xx tiles and holes, so this
 * sits at the level that is populated more or less everywhere and lets MapLibre
 * overzoom the last one where it is not.
 */
const DETAIL_MAXZOOM = Number(import.meta.env.VITE_SAT_MAXZOOM ?? 17)

const DETAIL =
  DETAIL_TILES === 'off'
    ? undefined
    : {
        tiles: DETAIL_TILES,
        maxzoom: DETAIL_MAXZOOM,
        attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
      }

/**
 * How far in the globe will go.
 *
 * Far enough to read a city from above — blocks, parks, the shape of a harbour
 * — because that is the other half of what a dot means: not just that a place
 * is on the map but what the place looks like. Past this the imagery starts
 * running out in the less-photographed half of the world, and the dots, which
 * hold their pixel size, would be sitting on individual rooftops.
 */
const MAX_ZOOM = 16

/** Slack around a dot for clicks and hovers that just miss it. */
const NEAR_MISS = 8

const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] }

/**
 * A map, and whether it is ready to be touched yet.
 *
 * Every setter that names a layer or a source — `setPaintProperty`, `setFilter`,
 * `setFeatureState` — throws "Style is not done loading" if it is called too
 * early, and React Query routinely delivers points first. So nothing touches the
 * map until `style.load`, and `applyAll` catches it up when that arrives.
 *
 * `style.load` specifically, because the two obvious alternatives are both wrong
 * in ways worth recording. `load` waits for the first *render* as well: a hidden
 * or throttled tab may not render for a long time, or at all, and this flag would
 * never flip. `isStyleLoaded()` is stricter still — false until every *source*
 * has loaded too, which for the raster source means waiting on tiles, which are
 * only requested once something renders. Neither describes the thing actually
 * being waited for, which is "has the style spec been parsed and do the layers
 * exist".
 */
type Bound = { map: MapLibreMap; styled: boolean }

export function Globe({
  points,
  litQids,
  friends,
  selectedQid,
  onSelect,
  onHover,
  flyTo,
  dotMode,
  links,
  nestLinks,
  collabs,
  onSelectLink,
  selectedLink,
  linkEnds,
  highlight,
  highlightIso,
  obscuredRight,
  obscuredLeft,
  obscuredBottom,
  onReady,
}: Props) {
  const container = useRef<HTMLDivElement>(null)
  const bound = useRef<Bound | null>(null)
  /** The dot the cursor is on, held by the map rather than by React. */
  const hovered = useRef<string | null>(null)
  /** The same, for arcs. Separate because a dot and an arc can both be under it. */
  const hoveredLink = useRef<string | null>(null)
  /**
   * The dots currently lit because the hovered arc ends there.
   *
   * Its own feature-state key rather than reusing `hover`: the pointer can be on
   * a dot and on an arc that ends at it in the same move, and one shared flag
   * would have the arc's cleanup switch the dot's own hover back off.
   */
  const hoveredLinkEnds = useRef<string[]>([])
  /**
   * The ends of the hovered arc that have no dot at all — a featuring partner
   * from a place your library never visits.
   *
   * A selected arc grows the same markers, but through React, from `linkEnds`.
   * These cannot: hover is owned by the map precisely so that the pointer path
   * never re-renders. So they are held here and merged in on upload.
   */
  const hoverGhosts = useRef<{ lon: number; lat: number }[]>([])

  /**
   * Props the map's own event handlers need to read.
   *
   * Kept as refs rather than closed over, so the handlers can be registered
   * once at construction instead of being torn down and re-attached every time
   * a prop changes — which for `onHover`, firing on every pointer move, is the
   * difference between the map owning the pointer path and React owning it.
   */
  const onSelectRef = useRef(onSelect)
  const onHoverRef = useRef(onHover)
  const selectedRef = useRef(selectedQid)
  const onSelectLinkRef = useRef(onSelectLink)
  const selectedLinkRef = useRef(selectedLink ?? null)
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  onSelectRef.current = onSelect
  onHoverRef.current = onHover
  selectedRef.current = selectedQid
  onSelectLinkRef.current = onSelectLink

  const byQid = useMemo(() => new Map(points.map((p) => [p.qid, p])), [points])
  const byQidRef = useRef(byQid)
  byQidRef.current = byQid

  /**
   * The country outlined right now, and the two things that ask for one.
   *
   * The menu's request wins over the globe's: while the cursor is on a row, that
   * is the country being talked about, even if the pointer happens to be resting
   * over a dot somewhere else. Held in refs because the map's own pointer
   * handlers set it, and those are registered once rather than re-bound per
   * render.
   */
  const dotIso = useRef<string | null>(null)
  const menuIso = useRef<string | null>(highlightIso ?? null)
  const drawnIso = useRef<string | null>(null)

  const paintCountry = (map: MapLibreMap) => {
    const iso = menuIso.current ?? dotIso.current
    if (iso === drawnIso.current) return
    drawnIso.current = iso
    const filter = countryFilter(iso)
    map.setFilter(LAYER.countryFill, filter)
    map.setFilter(LAYER.countryLine, filter)
  }

  /** Rebuilds the forced-label source. Owned by the map, called from React. */
  const syncFocusRef = useRef<(() => void) | null>(null)
  /** The qids whose own label is currently standing down for a forced copy. */
  const forcedQids = useRef<Set<string>>(new Set())

  /** Everything below goes through here rather than each guarding for itself. */
  const withMap = (fn: (map: MapLibreMap) => void) => {
    const b = bound.current
    if (b?.styled) fn(b.map)
  }

  useEffect(() => {
    menuIso.current = highlightIso ?? null
    withMap(paintCountry)
  }, [highlightIso])

  // ----- what the map is shown -----

  /**
   * One scale across both libraries.
   *
   * Both encodings in `dotsToGeoJSON` are relative to the maximum of the array
   * they are given, so letting each call find its own would draw a friend's
   * busiest city exactly as large as yours whether they have thirty tracks there
   * or three thousand — the comparison the overlay exists to make, silently
   * flattened. Passing the union maximum to both is what makes the two sets
   * legible against each other.
   */
  const scaleMax = useMemo(() => {
    const top = (rows: MapPoint[]) => rows.reduce((m, p) => (p.tracks > m ? p.tracks : m), 1)
    // Across every library on screen, not just yours and one of theirs: with two
    // overlays normalised separately, the smaller library's busiest city would
    // draw the same size as the larger one's and the comparison would be a lie.
    return Math.max(top(points), ...(friends ?? []).map((f) => top(f.points)))
  }, [points, friends])

  const dotsData = useMemo(
    () => dotsToGeoJSON(points, litQids ?? null, highlight ?? null, scaleMax),
    [points, litQids, highlight, scaleMax]
  )
  const friendData = useMemo(
    () =>
      friends?.length
        ? // Never dimmed and never spotlit: the overlay is passive, so search
          // and menu hover act on your library alone rather than quietly
          // rewriting what a friend's map says. Their *labels* are stood down
          // during a search instead — see the filter below.
          //
          // Your places go in as well: a ring has to know how big the dot it
          // surrounds is, and at a shared city that dot is yours.
          friendsToGeoJSON(byQid, friends, null, null, scaleMax)
        : EMPTY_FC,
    [friends, scaleMax, byQid]
  )
  const linkEndsData = useMemo(
    () =>
      linkEnds?.length
        ? {
            type: 'FeatureCollection' as const,
            features: linkEnds.map((p) => ({
              type: 'Feature' as const,
              geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
              properties: {},
            })),
          }
        : EMPTY_FC,
    [linkEnds]
  )
  const linksData = useMemo(
    () => (collabs ? linksToGeoJSON(links) : EMPTY_FC),
    [links, collabs]
  )
  const nestData = useMemo(() => linksToGeoJSON(nestLinks), [nestLinks])

  const setDots = (map: MapLibreMap) => {
    const src = map.getSource(SOURCE.dots) as GeoJSONSource | undefined
    src?.setData(dotsRef.current as unknown as GeoJSON.FeatureCollection)
    // setData drops feature-state along with the features it replaces.
    const sel = selectedRef.current
    if (sel) map.setFeatureState({ source: SOURCE.dots, id: sel }, { selected: true })
    if (hovered.current) {
      map.setFeatureState({ source: SOURCE.dots, id: hovered.current }, { hover: true })
    }
    // The ends of a hovered arc are lit through the dots, so they go with them.
    // A dot that this rebuild removed is dropped rather than re-lit.
    hoveredLinkEnds.current = hoveredLinkEnds.current.filter((qid) =>
      byQidRef.current.has(qid)
    )
    for (const qid of hoveredLinkEnds.current) {
      map.setFeatureState({ source: SOURCE.dots, id: qid }, { linked: true })
    }
    // `forced` went with them, so the sync has to start from nothing believed
    // set rather than diffing against state that no longer exists.
    forcedQids.current = new Set()
    syncFocusRef.current?.()
  }

  /**
   * The overlay: data in, hover back on.
   *
   * Colour is no longer painted here — it is a property of each feature, so it
   * arrives with the data. State does have to be restored, unlike the version of
   * this that held none: `setData` drops feature-state with the features it
   * replaces, and the marks now carry hover like your own dots do.
   */
  const setFriendDots = (map: MapLibreMap) => {
    const src = map.getSource(SOURCE.friendDots) as GeoJSONSource | undefined
    src?.setData(friendRef.current as unknown as GeoJSON.FeatureCollection)
    for (const fid of friendHovered.current) {
      map.setFeatureState({ source: SOURCE.friendDots, id: fid }, { hover: true })
    }
  }

  /**
   * The placeholder rings: both the selected arc's ends, which arrive as a prop,
   * and the hovered arc's, which the map fills in for itself.
   *
   * One source rather than two layers, so a hovered ring and a selected one
   * cannot disagree about what a placeholder looks like. Deduped by position
   * because hovering the arc you already have open would otherwise stack two
   * rings at 90% alpha on the same pixel and quietly brighten them.
   *
   * No feature-state to restore, unlike `setDots` — these are drawn or they are
   * not.
   */
  const setLinkEnds = (map: MapLibreMap) => {
    const src = map.getSource(SOURCE.linkEnds) as GeoJSONSource | undefined
    if (!src) return
    const features: GeoJSON.Feature<GeoJSON.Point>[] = [...linkEndsRef.current.features]
    const at = (lon: number, lat: number) => `${lon.toFixed(5)},${lat.toFixed(5)}`
    const seen = new Set(
      features.map((f) => at(f.geometry.coordinates[0], f.geometry.coordinates[1]))
    )
    for (const p of hoverGhosts.current) {
      const key = at(p.lon, p.lat)
      if (seen.has(key)) continue
      seen.add(key)
      features.push({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
        properties: {},
      })
    }
    src.setData({ type: 'FeatureCollection', features } as unknown as GeoJSON.FeatureCollection)
  }

  /**
   * Containment: data in, nothing else.
   *
   * No feature-state to restore, unlike `setLinks` — these are never hovered
   * and never selected, so replacing their features has nothing to put back.
   */
  const setNestLinks = (map: MapLibreMap) => {
    const src = map.getSource(SOURCE.nestLinks) as GeoJSONSource | undefined
    src?.setData(nestRef.current as unknown as GeoJSON.FeatureCollection)
  }

  const setLinks = (map: MapLibreMap) => {
    const src = map.getSource(SOURCE.links) as GeoJSONSource | undefined
    src?.setData(linksRef.current as unknown as GeoJSON.FeatureCollection)
    applyLinkQuiet(map, Boolean(selectedLinkRef.current))
    // setData drops feature-state with the features it replaces, exactly as it
    // does for the dots — and links are rebuilt on every mode switch and every
    // filter change, so without this a read arc goes dark the moment a chip
    // moves. The hovered one is not restored: the pointer has not moved, but
    // the arc under it may no longer exist.
    const arc = selectedLinkRef.current
    if (arc) map.setFeatureState({ source: SOURCE.links, id: arc }, { selected: true })
    hoveredLink.current = null
    // The arc that lit them is gone, and the dots' own state survived the
    // rebuild — so it has to be put out by hand rather than left glowing until
    // the pointer next moves.
    for (const qid of hoveredLinkEnds.current) {
      map.setFeatureState({ source: SOURCE.dots, id: qid }, { linked: false })
    }
    hoveredLinkEnds.current = []
    // The ghost rings that arc grew go with it, or one is left floating over a
    // place nothing on the map still points at.
    hoverGhosts.current = []
    setLinkEnds(map)
  }

  /**
   * The strings belonging to whatever you have picked, lifted out of the faint
   * mass beneath. A filter rather than a separate source, because the arcs are
   * already uploaded and this only changes which of them the second layer draws.
   */
  const setActiveLinks = (map: MapLibreMap) => {
    const sel = selectedRef.current
    map.setFilter(
      LAYER.linksActive,
      sel ? ['any', ['==', ['get', 'a'], sel], ['==', ['get', 'b'], sel]] : ['==', ['get', 'a'], ' ']
    )
  }

  /**
   * Push every piece of React state at the map, from scratch.
   *
   * This has to exist as a whole rather than as the sum of the effects below.
   * The map is built inside an effect, and an effect can be torn down and re-run
   * — StrictMode does it on every mount in development, and any remount of the
   * route does it in production — while the effects that feed it do *not* re-run,
   * because their own dependencies have not changed. A map populated only by
   * those effects is therefore empty for its whole life the second time round:
   * style loads, nothing ever arrives, and the planet sits there with no dots on
   * it. So the map asks for everything itself, once, as soon as it can.
   */
  const applyAll = (map: MapLibreMap) => {
    const coast = map.getSource(SOURCE.coast) as GeoJSONSource | undefined
    coast?.setData(coastlines as unknown as GeoJSON.FeatureCollection)
    setDots(map)
    // Including the rings, which used to be left out — and the effect that feeds
    // them has `friendData` in its deps, which does not change on a remount. So
    // a friend's overlay went missing for the whole life of the second map, in
    // exactly the way the note above describes for everything else.
    setFriendDots(map)
    setNestLinks(map)
    setLinks(map)
    setLinkEnds(map)
    setActiveLinks(map)
    applyDotMode(map, dotModeRef.current)
    // A fresh style starts with both highlight layers filtered to nothing, so
    // what was drawn before is no longer true — clear the record or paintCountry
    // sees no change to make and the outline never comes back.
    drawnIso.current = null
    paintCountry(map)
    syncFocusRef.current?.()
  }

  const dotsRef = useRef(dotsData)
  const linkEndsRef = useRef(linkEndsData)
  /**
   * The friend marks currently lit, by feature id.
   *
   * A set rather than one id, because one place can be several marks: hovering a
   * city you share with three libraries should light all three of their rings,
   * not an arbitrary one of them.
   */
  const friendHovered = useRef<string[]>([])
  /** Every friend feature id at a qid, so hovering a place can light them all. */
  const friendFidsRef = useRef<Map<string, string[]>>(new Map())
  /**
   * Their places by qid, for the label machinery.
   *
   * Only places *you do not have* need to be in here — where you have it too,
   * your own point is found first and carries the same name and coordinates.
   */
  const friendPointRef = useRef<Map<string, MapPoint>>(new Map())
  const friendRef = useRef(friendData)
  const linksRef = useRef(linksData)
  const nestRef = useRef(nestData)
  const dotModeRef = useRef(dotMode)
  const collabsRef = useRef(collabs)
  dotsRef.current = dotsData
  linkEndsRef.current = linkEndsData
  friendRef.current = friendData
  friendPointRef.current = useMemo(() => {
    const by = new Map<string, MapPoint>()
    for (const lib of friends ?? []) {
      for (const p of lib.points) if (!by.has(p.qid)) by.set(p.qid, p)
    }
    return by
  }, [friends])
  friendFidsRef.current = useMemo(() => {
    const by = new Map<string, string[]>()
    for (const f of friendData.features) {
      const { qid, fid } = f.properties
      const list = by.get(qid)
      if (list) list.push(fid)
      else by.set(qid, [fid])
    }
    return by
  }, [friendData])
  linksRef.current = linksData
  nestRef.current = nestData
  dotModeRef.current = dotMode
  collabsRef.current = collabs

  // ----- construction -----

  useEffect(() => {
    if (!container.current) return

    const map = new MapLibreMap({
      container: container.current,
      style: buildStyle(
        '/glyphs/{fontstack}/{range}.pbf',
        '/earth/{z}/{x}/{y}.jpg',
        EARTH_MAXZOOM,
        DETAIL
      ),

      center: [0, 15],
      // Corrected to the real fill zoom as soon as the container has been
      // measured; this is only what the first frame is drawn at.
      zoom: 2,
      maxZoom: MAX_ZOOM,
      // The globe has no meaningful north-up-ness to lose and no terrain to
      // look across, so tilting and twisting are only ways to get lost.
      pitch: 0,
      bearing: 0,
      dragRotate: false,
      touchPitch: false,
      attributionControl: false,
      // One world, not a repeating strip — this is a planet.
      renderWorldCopies: false,
      // Radio Garden's own cap. Past 2 the extra fragments buy nothing anyone
      // can see and cost real frames on an integrated GPU.
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      // Fade the whole planet in rather than having it appear at full strength
      // the instant the first tile lands.
      fadeDuration: 180,
    })
    const self: Bound = { map, styled: false }
    bound.current = self
    /**
     * Keep the floor of the zoom range tied to the size of the window.
     *
     * Also re-frames the globe on the first pass and whenever a resize would
     * otherwise leave it below the new floor — so widening the window grows the
     * planet rather than adding black around it.
     */
    let framed = false
    const reframe = () => {
      applyMinZoom(map)
      const fill = fillZoom(map)
      // Still unframed if the container had no size: the resize that gives it
      // one comes back through here, and does the framing then.
      if (!framed && fill != null) {
        framed = true
        map.setZoom(fill)
      }
    }
    map.on('resize', reframe)
    // The floor moves with the centre, so it has to be recomputed after every
    // move and not only when the window changes size.
    map.on('moveend', () => applyMinZoom(map))

    // Pinch zooms; it never twists. Rotation on a globe with no compass is just
    // a way to end up sideways with no way back.
    map.touchZoomRotate.disableRotation()
    // MapLibre's own default caps a flick at the same speed it decelerates,
    // which makes a hard throw feel identical to a gentle one. Radio Garden
    // removes the cap; a spin should be worth what you put into it.
    map.dragPan.enable({ deceleration: 1400, maxSpeed: Infinity })

    // ----- pointer -----

    /**
     * The dot under a screen position.
     *
     * `queryRenderedFeatures` asks what was actually drawn there, so what you
     * can click is exactly what you can see — including the horizon, since a dot
     * on the far side of the planet is not rendered and so cannot be hit. The
     * box is a few pixels of slack for a click that just misses.
     */
    const dotAt = (p: ScreenPoint): MapGeoJSONFeature | null => {
      const box: [PointLike, PointLike] = [
        [p.x - NEAR_MISS, p.y - NEAR_MISS],
        [p.x + NEAR_MISS, p.y + NEAR_MISS],
      ]
      // Yours first. Where you both have a city their dot is drawn *around*
      // yours, so a click in the middle is on both — and it should mean the
      // library the panel can say most about.
      const mine = map.queryRenderedFeatures(box, { layers: [LAYER.dots] })
      const hits = mine.length
        ? mine
        : map.queryRenderedFeatures(box, { layers: [LAYER.friendDots] })
      if (!hits.length) return null
      // Prefer the nearest centre, so a small dot sitting on top of a large one
      // is reachable rather than permanently shadowed by it.
      let best = hits[0]
      let bestD = Infinity
      for (const f of hits) {
        const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates
        const at = map.project([lon, lat])
        const d = Math.hypot(at.x - p.x, at.y - p.y)
        if (d < bestD) {
          bestD = d
          best = f
        }
      }
      return best
    }

    /**
     * Which library a hit came from, and its qid.
     *
     * The friend source now promotes a namespaced `fid` — `libraryId:qid` — so a
     * hit knows not merely that it is somebody else's but whose. The qid is read
     * from properties rather than split back out of the id, because a qid is a
     * qid and reconstructing one by string surgery is how it eventually contains
     * a colon.
     */
    const dotQid = (f: MapGeoJSONFeature): { qid: string; owner: Owner } | null => {
      if (f.layer.id === LAYER.friendDots) {
        const qid = f.properties?.qid
        return typeof qid === 'string' && qid ? { qid, owner: 'theirs' } : null
      }
      return f.id == null ? null : { qid: String(f.id), owner: 'mine' }
    }

    /**
     * The collaboration arc under a screen position.
     *
     * Scoped to the hit layer and nothing else. An unscoped query here would
     * also return the country wash, the friend rings and the dots — all of
     * which are meant to be passive or are handled elsewhere — and the arcs
     * would start stealing pointer events from them.
     *
     * Nesting arcs are excluded rather than merely ignored on click: there is
     * nothing behind "Brooklyn is inside New York City" to open, so lighting one
     * up under the cursor would promise a panel that never arrives.
     */
    const linkAt = (p: ScreenPoint): MapGeoJSONFeature | null => {
      if (!collabsRef.current) return null
      const box: [PointLike, PointLike] = [
        [p.x - NEAR_MISS, p.y - NEAR_MISS],
        [p.x + NEAR_MISS, p.y + NEAR_MISS],
      ]
      const hits = map.queryRenderedFeatures(box, { layers: [LAYER.linksHit] })
      if (!hits.length) return null
      /**
       * Nearest line wins, the way the nearest dot centre does.
       *
       * Preferring the *busiest* arc instead reads well — it is the one drawn
       * brightest — right up until it makes the faint ones unreachable. A
       * one-track arc between two towns outside Milan is crossed by every Milan
       * arc along its whole length, so the busier neighbour won every box and
       * the thin arc could not be clicked anywhere at all. Measured, not
       * theorised: the tie-break never once chose it.
       *
       * Ties — a genuine crossing, within half a pixel — still go to the busier
       * arc, which is the one you appear to be pointing at.
       */
      let best = hits[0]
      let bestD = Infinity
      for (const f of hits) {
        const d = distToLine(f.geometry, p)
        const busier =
          Number(f.properties?.tracks ?? 0) > Number(best.properties?.tracks ?? 0)
        if (d < bestD - 0.5 || (d <= bestD + 0.5 && busier)) {
          best = f
          bestD = Math.min(d, bestD)
        }
      }
      return best
    }

    /** Screen-space distance from a point to a queried line, in pixels. */
    const distToLine = (geom: GeoJSON.Geometry, p: ScreenPoint) => {
      const lines: GeoJSON.Position[][] =
        geom.type === 'MultiLineString'
          ? (geom.coordinates as GeoJSON.Position[][])
          : geom.type === 'LineString'
            ? [geom.coordinates as GeoJSON.Position[]]
            : []
      let best = Infinity
      for (const line of lines) {
        for (let i = 1; i < line.length; i++) {
          const a = map.project(line[i - 1] as [number, number])
          const b = map.project(line[i] as [number, number])
          const dx = b.x - a.x
          const dy = b.y - a.y
          const len = dx * dx + dy * dy
          // A degenerate segment is a point; clamping t to [0,1] on a zero
          // length would divide by it.
          const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len))
          best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)))
        }
      }
      return best
    }

    /**
     * The same feature-state trick the dots use, for arcs — and for the two
     * dots the arc ends at, which light with it.
     *
     * The ends are read off the arc's own properties, the same pair a click
     * would select, so what a hover promises and what a click opens cannot
     * drift.
     *
     * An end with no dot is the interesting half. Those are the places a
     * featuring partner comes from that your library never otherwise visits —
     * the arc ends in nothing, and a lit thread going nowhere is the one thing
     * the hover most needs to answer. So they get the same hollow ring a
     * selected arc grows for them, uploaded straight to the ends source.
     */
    const setLinkHover = (feature: MapGeoJSONFeature | null) => {
      const id = feature?.id == null ? null : String(feature.id)
      if (id === hoveredLink.current) return
      if (hoveredLink.current) {
        map.setFeatureState({ source: SOURCE.links, id: hoveredLink.current }, { hover: false })
      }
      for (const qid of hoveredLinkEnds.current) {
        map.setFeatureState({ source: SOURCE.dots, id: qid }, { linked: false })
      }
      hoveredLink.current = id
      hoveredLinkEnds.current = []
      hoverGhosts.current = []
      if (id) {
        map.setFeatureState({ source: SOURCE.links, id }, { hover: true })
        const props = feature?.properties ?? {}
        for (const end of ['a', 'b'] as const) {
          const qid = props[end]
          if (typeof qid !== 'string') continue
          if (byQidRef.current.has(qid)) {
            hoveredLinkEnds.current.push(qid)
            map.setFeatureState({ source: SOURCE.dots, id: qid }, { linked: true })
            continue
          }
          const lon = Number(props[`${end}lon`])
          const lat = Number(props[`${end}lat`])
          // A link built before this carried coordinates, or one whose place has
          // none, is left unmarked rather than pinned to null island.
          if (Number.isFinite(lon) && Number.isFinite(lat)) {
            hoverGhosts.current.push({ lon, lat })
          }
        }
      }
      setLinkEnds(map)
    }

    /**
     * Feature-state, so hover costs a repaint rather than a data upload.
     *
     * A place is one thing however many libraries have it, so this lights your
     * dot and every friend mark sharing the qid at once — three libraries' rings
     * around one city brighten together, which is what makes them read as rings
     * *around* it rather than as three unrelated marks.
     */
    const setHover = (qid: string | null) => {
      if (qid === hovered.current) return
      if (hovered.current) {
        map.setFeatureState({ source: SOURCE.dots, id: hovered.current }, { hover: false })
      }
      for (const fid of friendHovered.current) {
        map.setFeatureState({ source: SOURCE.friendDots, id: fid }, { hover: false })
      }
      friendHovered.current = qid ? (friendFidsRef.current.get(qid) ?? []) : []
      hovered.current = qid
      if (qid) map.setFeatureState({ source: SOURCE.dots, id: qid }, { hover: true })
      for (const fid of friendHovered.current) {
        map.setFeatureState({ source: SOURCE.friendDots, id: fid }, { hover: true })
      }
      map.getCanvas().style.cursor = qid ? 'pointer' : ''
      dotIso.current = qid ? (byQidRef.current.get(qid)?.country_iso ?? null) : null
      paintCountry(map)
      onHoverRef.current(qid)
      syncFocusLabels()
    }

    /**
     * Whether this dot's own name is on screen right now.
     *
     * `queryRenderedFeatures` asks the collision index, which holds only the
     * symbols that were actually placed — a name squeezed out by a busier
     * neighbour is not in it, and neither is one belonging to a dimmed dot,
     * since those are filtered out of the layer. So the one question answers
     * both reasons a name can be missing, without this having to know either.
     */
    const labelPlaced = (qid: string) => {
      // Both layers: a place only they have gets its name from the friend layer,
      // and forcing a second copy of a name already on screen is exactly the
      // doubling the focus layer exists to avoid.
      const layers = [LAYER.labels, LAYER.friendLabels].filter((id) => map.getLayer(id))
      if (!layers.length) return false
      return map
        .queryRenderedFeatures({ layers })
        .some((f) => String(f.id) === qid || f.properties?.qid === qid)
    }

    /**
     * The names that force their way through the collision grid.
     *
     * Whatever is selected, always: picking a place is a commitment, and its
     * name should survive any crowd. What the cursor is on, only when that name
     * is not already drawn — otherwise the forced copy lands a few pixels off
     * the placed one and the place appears to be named twice. A dot whose label
     * is visible is brightened in place by the labels layer instead.
     *
     * Never more than two features, so rebuilding the source outright is
     * cheaper than reasoning about a diff.
     */
    let lastFocusKey = ''
    const syncFocusLabels = () => {
      const src = map.getSource(SOURCE.focus) as GeoJSONSource | undefined
      if (!src) return
      const sel = selectedRef.current
      const hov = hovered.current
      // Their places count as places here. Looking one up falls back to the
      // overlay, or hovering a city only they have would silently decline to
      // force its name — the one case where the label is most likely to have
      // been collided away, since their names are placed after yours.
      const known = (qid: string) => byQidRef.current.has(qid) || friendPointRef.current.has(qid)
      const qids: string[] = []
      if (sel && known(sel)) qids.push(sel)
      if (hov && hov !== sel && known(hov) && !labelPlaced(hov)) qids.push(hov)

      // Only when it has actually changed. `idle` calls this to re-decide once
      // placement has settled, and setting the same data again would dirty the
      // source, provoke another render, and idle straight back into here.
      const key = qids.join('|')
      if (key !== lastFocusKey) {
        lastFocusKey = key
        src.setData({
          type: 'FeatureCollection',
          features: qids.map((qid) => {
            const p = (byQidRef.current.get(qid) ?? friendPointRef.current.get(qid))!
            return {
              type: 'Feature' as const,
              geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
              properties: { name: p.name },
            }
          }),
        })
      }

      // Mirror the same set onto the dots, so exactly these names — and no
      // others — go transparent in the layer that placed them.
      //
      // Onto *both* sources. A place only an imported library has is labelled by
      // the friend layer, and leaving that layer's copy standing while the focus
      // layer drew a forced one is how those places came to be named twice.
      const setForced = (qid: string, on: boolean) => {
        map.setFeatureState({ source: SOURCE.dots, id: qid }, { forced: on })
        for (const fid of friendFidsRef.current.get(qid) ?? []) {
          map.setFeatureState({ source: SOURCE.friendDots, id: fid }, { forced: on })
        }
      }
      const next = new Set(qids)
      for (const qid of forcedQids.current) if (!next.has(qid)) setForced(qid, false)
      for (const qid of next) if (!forcedQids.current.has(qid)) setForced(qid, true)
      forcedQids.current = next
    }
    syncFocusRef.current = syncFocusLabels

    // Placement is redone as the camera moves, so a name that had to be forced
    // at world view may find room of its own on the way in — and should hand
    // its slot back when it does. `idle` is when the collision index is settled
    // enough to be asked.
    map.on('idle', () => {
      if (hovered.current) syncFocusLabels()
    })

    // Once, and only the first time: every later idle is a camera settling, not
    // the map arriving, and the loader must not be able to come back over a
    // globe you are already using.
    map.once('idle', () => onReadyRef.current?.())

    map.on('mousemove', (e) => {
      const hit = dotAt(e.point)
      const at = hit ? dotQid(hit) : null
      // Either library's mark lights the place: setHover works on the qid, and
      // the friend source now carries ids of its own to set state on.
      setHover(at?.qid ?? null)
      // A dot wins outright. Arcs converge on the places they join, so near a
      // busy city every dot sits on a bundle of them — and the dot is both the
      // smaller target and the more likely intent.
      const arc = at ? null : linkAt(e.point)
      setLinkHover(arc)
      // setHover already claimed the cursor for a dot; an arc has to claim it
      // too, or a clickable thing sits under an arrow.
      if (!at) map.getCanvas().style.cursor = arc ? 'pointer' : ''
    })
    map.on('mouseout', () => {
      setHover(null)
      setLinkHover(null)
    })

    /**
     * Selection happens here and nowhere else.
     *
     * MapLibre does not fire `click` at the end of a drag, which is the whole of
     * what the canvas globe needed a travel threshold for: letting go of the
     * planet with the cursor over a dot used to tune into wherever your hand
     * happened to stop.
     */
    map.on('click', (e) => {
      const hit = dotAt(e.point)
      const at = hit ? dotQid(hit) : null
      if (at) {
        onSelectRef.current(at.qid, at.owner)
        return
      }
      // Same precedence as the hover, so what you clicked is what was lit.
      const arc = linkAt(e.point)
      const a = arc?.properties?.a
      const b = arc?.properties?.b
      if (a && b) onSelectLinkRef.current?.(String(a), String(b))
    })

    // A tap has no hover to leave behind, and leaving one set would keep a name
    // and a lit dot on screen with nothing pointing at them — or, for an arc, a
    // bright thread and a ring around a place the tap has already moved on from.
    map.on('touchend', () => {
      setHover(null)
      setLinkHover(null)
    })

    /**
     * A lost context leaves a black hole where the planet was, and it happens
     * for reasons that have nothing to do with this app — a laptop waking, a
     * driver reset, another tab exhausting the GPU. The style survives; only the
     * GPU-side resources do not, so asking for a repaint is enough.
     */
    const canvas = map.getCanvas()
    // preventDefault is what tells the browser to bother restoring it at all.
    const onLost = (e: Event) => e.preventDefault()
    const onRestored = () => map.triggerRepaint()
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)

    // Last, so that the first `applyAll` runs with every handler above it in
    // place — `syncFocusLabels` in particular, which it calls.
    const styleReady = () => {
      if (self.styled) return
      self.styled = true
      reframe()
      applyAll(map)
    }
    map.on('style.load', styleReady)
    // A style given as an object rather than as a URL is parsed synchronously,
    // inside the constructor — so `style.load` has already fired by the time
    // there is anything listening for it, and waiting on the event alone leaves
    // the map permanently empty. `getLayer` is the probe because it answers
    // without throwing whether or not the style is up.
    if (map.getLayer(LAYER.dots)) styleReady()

    return () => {
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      syncFocusRef.current = null
      hovered.current = null
      hoveredLink.current = null
      hoveredLinkEnds.current = []
      hoverGhosts.current = []
      forcedQids.current = new Set()
      bound.current = null
      map.remove()
    }
  }, [])

  // ----- keeping it up to date -----

  useEffect(() => withMap(setDots), [dotsData])
  useEffect(() => withMap(setFriendDots), [friendData])
  useEffect(() => withMap(setLinkEnds), [linkEndsData])
  useEffect(() => withMap(setNestLinks), [nestData])
  useEffect(() => withMap(setLinks), [linksData])
  useEffect(() => withMap((map) => applyDotMode(map, dotMode)), [dotMode])

  // The arc being read about stays lit while its panel is open, the same way a
  // selected dot does — otherwise the only thing tying the panel to the globe is
  // the reader's memory of which thread they clicked.
  const prevLink = useRef<string | null>(null)
  useEffect(() => {
    selectedLinkRef.current = selectedLink ?? null
    withMap((map) => {
      if (prevLink.current && prevLink.current !== selectedLink) {
        map.setFeatureState({ source: SOURCE.links, id: prevLink.current }, { selected: false })
      }
      if (selectedLink) {
        map.setFeatureState({ source: SOURCE.links, id: selectedLink }, { selected: true })
      }
      // The line that actually turns the quieting on and off.
      applyLinkQuiet(map, Boolean(selectedLink))
    })
    prevLink.current = selectedLink ?? null
  }, [selectedLink])

  const prevSelected = useRef<string | null>(null)
  useEffect(() => {
    withMap((map) => {
      // Both sources. A place only an imported library has has no feature in
      // yours, so selecting it used to set state on nothing and the dot you had
      // just clicked stayed exactly as it was.
      const select = (qid: string, on: boolean) => {
        map.setFeatureState({ source: SOURCE.dots, id: qid }, { selected: on })
        for (const fid of friendFidsRef.current.get(qid) ?? []) {
          map.setFeatureState({ source: SOURCE.friendDots, id: fid }, { selected: on })
        }
      }
      if (prevSelected.current && prevSelected.current !== selectedQid) {
        select(prevSelected.current, false)
      }
      if (selectedQid) select(selectedQid, true)
      setActiveLinks(map)
      syncFocusRef.current?.()
    })
    prevSelected.current = selectedQid
  }, [selectedQid])

  // ----- camera -----

  /**
   * The instruction the camera has already carried out.
   *
   * The effect below lists the insets because it reads them, but a change to one
   * is not a new instruction — and flyTo is never cleared, so re-running on an
   * inset change re-flew to whatever place was last picked. That threw the
   * camera back there after you had panned away by hand, fired a fresh 1.4s
   * flight on every pointermove while the sheet was being dragged, and lurched
   * sideways and back each time the sheet crossed the tall/short threshold and
   * swapped a bottom strip of padding for a left column of it.
   *
   * Compared by identity rather than by `key`: the route builds a fresh object
   * per selection, so identity is exactly "a new instruction" — including
   * picking the same place twice, which a key would have swallowed.
   */
  const flown = useRef<FlyTarget | null>(null)

  useEffect(() => {
    if (!flyTo || flyTo === flown.current) return
    flown.current = flyTo
    withMap((map) => {
      // What the camera would do to fit the box, centre and zoom together. Both
      // are taken, or neither: see the note on FlyTarget for why splitting them
      // is a scale error rather than an offset.
      //
      // cameraForBounds is globe-aware here — it solves the real globe matrix
      // against the box's corners and edge midpoints — so this is not a mercator
      // approximation being applied to a sphere.
      let center: [number, number]
      let zoom: number

      if (flyTo.kind === 'fit') {
        let cam
        try {
          cam = map.cameraForBounds(flyTo.bounds, {
            padding: framePadding(map, obscuredLeft ?? 0, obscuredRight ?? 0, obscuredBottom ?? 0),
            maxZoom: flyTo.maxZoom ?? COUNTRY_MAX_ZOOM,
          })
        } catch {
          // Thrown, not returned, when the window is too small for the insets —
          // see framePadding. Nothing to recover to but staying put.
          return
        }
        // A box the camera cannot solve — it gives up near the limb, where a
        // span like Russia's is foreshortened almost to nothing. Leaving the
        // globe where it is beats throwing it somewhere arbitrary.
        if (!cam?.center) return
        const c = LngLat.convert(cam.center)
        center = [c.lng, c.lat]
        zoom = cam.zoom ?? map.getZoom()
      } else {
        center = [flyTo.lon, flyTo.lat]
        zoom = flyTo.zoom
      }

      // The floor is a function of where the camera is *going*, not where it is:
      // the planet is drawn larger the nearer the centre is to a pole, so a
      // flight north would otherwise be clamped all the way by the departure
      // latitude's floor and arrive too far out.
      applyMinZoom(map, center[1])

      // Duration from how far the planet has to turn, so a hop across a country
      // is not given the same three seconds as a hop across the world.
      const from = map.getCenter()
      const turn = from.distanceTo(new LngLat(center[0], center[1]))
      const duration = turn < 1_000_000 ? 1400 : 2400

      // Short hops ease; long ones arc out and back in, which reads as one
      // motion instead of a scramble across the surface.
      if (turn < 1_000_000) {
        map.easeTo({ center, zoom, duration, easing: (t) => -0.5 * (Math.cos(Math.PI * t) - 1) })
      } else {
        map.flyTo({ center, zoom, duration, curve: 1.42, speed: 1.2 })
      }
    })
  }, [flyTo, obscuredRight, obscuredLeft, obscuredBottom])

  return <div ref={container} className="globe-canvas" />
}
