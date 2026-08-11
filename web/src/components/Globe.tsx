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
import type { MapPoint, PlaceLink } from '../lib/api'
import { coastlines, dotsToGeoJSON, linksToGeoJSON } from './globe/geo'
import { LAYER, SOURCE, applyDotMode, applyLinkMode, buildStyle } from './globe/layers'
import type { DotMode, LinkMode } from './globe/ramp'

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

export { DOT_MODES, LINK_MODES, rampAt } from './globe/ramp'
export type { DotMode, LinkMode } from './globe/ramp'

type Props = {
  points: MapPoint[]
  /** Dots matching the active search stay lit; the rest dim. Null = no filter. */
  litQids: Set<string> | null
  selectedQid: string | null
  /** Only ever a deliberate click — dragging the globe never selects. */
  onSelect: (qid: string) => void
  /** Whatever the cursor is over, for the floating name readout. */
  onHover: (qid: string | null) => void
  /**
   * Rotate the globe here. Not a MapPoint, because a country has no dot of its
   * own — it is flown to by the centroid of the places inside it.
   */
  flyTo: FlyTarget | null
  /** How magnitude is encoded: dot area, or colour at a fixed size. */
  dotMode: DotMode
  /** The strings to draw between places, already chosen by `linkMode`. */
  links: PlaceLink[]
  /** Which relation those strings represent, which is also how they are drawn. */
  linkMode: LinkMode
  /**
   * Lit from outside the canvas — hovering a row in the place menu highlights
   * the same dots as hovering them on the globe.
   */
  highlight?: Set<string> | null
}

/**
 * Where to send the globe, and how to treat the zoom.
 *
 * `zoom` is a framing: fit this country, or go back to the whole world, however
 * close you happen to be. `zoomAtLeast` is a floor: get at least this close, but
 * if you are already closer then stay there. Picking a single place uses the
 * floor, because zooming *out* to show you the thing you just picked is the
 * opposite of what selecting it means.
 *
 * Both are MapLibre zoom levels. They used to be d3 projection scale factors,
 * which are roughly two to the power of these — so what was a 0.55 *multiplier*
 * on the old scale is now a subtraction of about 0.86 levels, which is what
 * `zoomBack` carries.
 */
export type FlyTarget = {
  lat: number
  lon: number
  /** An absolute framing: go exactly this close, in or out. */
  zoom?: number
  /**
   * A framing worked out from what has to fit on screen, as
   * `[[west, south], [east, north]]`. Preferred over `zoom` when both are
   * given, and the centre still comes from `lat`/`lon` rather than from the
   * middle of the box — a country is aimed at where its music is.
   */
  bounds?: [[number, number], [number, number]]
  /** A floor: get at least this close, but never pull back to reach it. */
  zoomAtLeast?: number
  /**
   * Hold back this many zoom levels from the framing, and treat the result as a
   * floor rather than a target. What a hover uses: enough to see where you are
   * being shown, short of the commitment a click makes.
   */
  zoomBack?: number
  key?: string
}

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
 * How far in the globe will go.
 *
 * The imagery turns soft well before this and the coastline overlay takes over,
 * but the dots do not: at street scale the point of zooming is to separate
 * places that overlap — the boroughs, the Bay Area, the dozen dots stacked on
 * London — and for that the map behind them is only backdrop.
 */
const MAX_ZOOM = 12

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
  selectedQid,
  onSelect,
  onHover,
  flyTo,
  dotMode,
  links,
  linkMode,
  highlight,
}: Props) {
  const container = useRef<HTMLDivElement>(null)
  const bound = useRef<Bound | null>(null)
  /** The dot the cursor is on, held by the map rather than by React. */
  const hovered = useRef<string | null>(null)

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
  onSelectRef.current = onSelect
  onHoverRef.current = onHover
  selectedRef.current = selectedQid

  const byQid = useMemo(() => new Map(points.map((p) => [p.qid, p])), [points])
  const byQidRef = useRef(byQid)
  byQidRef.current = byQid

  /** Rebuilds the forced-label source. Owned by the map, called from React. */
  const syncFocusRef = useRef<(() => void) | null>(null)

  /** Everything below goes through here rather than each guarding for itself. */
  const withMap = (fn: (map: MapLibreMap) => void) => {
    const b = bound.current
    if (b?.styled) fn(b.map)
  }

  // ----- what the map is shown -----

  const dotsData = useMemo(
    () => dotsToGeoJSON(points, litQids ?? null, highlight ?? null),
    [points, litQids, highlight]
  )
  const linksData = useMemo(
    () => (linkMode === 'none' ? EMPTY_FC : linksToGeoJSON(links)),
    [links, linkMode]
  )

  const setDots = (map: MapLibreMap) => {
    const src = map.getSource(SOURCE.dots) as GeoJSONSource | undefined
    src?.setData(dotsRef.current as unknown as GeoJSON.FeatureCollection)
    // setData drops feature-state along with the features it replaces.
    const sel = selectedRef.current
    if (sel) map.setFeatureState({ source: SOURCE.dots, id: sel }, { selected: true })
    if (hovered.current) {
      map.setFeatureState({ source: SOURCE.dots, id: hovered.current }, { hover: true })
    }
  }

  const setLinks = (map: MapLibreMap) => {
    const src = map.getSource(SOURCE.links) as GeoJSONSource | undefined
    src?.setData(linksRef.current as unknown as GeoJSON.FeatureCollection)
    applyLinkMode(map, linkModeRef.current)
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
    setLinks(map)
    setActiveLinks(map)
    applyDotMode(map, dotModeRef.current)
    syncFocusRef.current?.()
  }

  const dotsRef = useRef(dotsData)
  const linksRef = useRef(linksData)
  const dotModeRef = useRef(dotMode)
  const linkModeRef = useRef(linkMode)
  dotsRef.current = dotsData
  linksRef.current = linksData
  dotModeRef.current = dotMode
  linkModeRef.current = linkMode

  // ----- construction -----

  useEffect(() => {
    if (!container.current) return

    const map = new MapLibreMap({
      container: container.current,
      style: buildStyle('/glyphs/{fontstack}/{range}.pbf', '/earth/{z}/{x}/{y}.jpg', EARTH_MAXZOOM),
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
      const fill = fillZoom(map)
      map.setMinZoom(fill - ZOOM_OUT_ROOM)
      if (!framed) {
        framed = true
        map.setZoom(fill)
      }
    }
    map.on('resize', reframe)

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
      const hits = map.queryRenderedFeatures(box, { layers: [LAYER.dots] })
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

    /** Feature-state, so hover costs a repaint rather than a data upload. */
    const setHover = (qid: string | null) => {
      if (qid === hovered.current) return
      if (hovered.current) {
        map.setFeatureState({ source: SOURCE.dots, id: hovered.current }, { hover: false })
      }
      hovered.current = qid
      if (qid) map.setFeatureState({ source: SOURCE.dots, id: qid }, { hover: true })
      map.getCanvas().style.cursor = qid ? 'pointer' : ''
      onHoverRef.current(qid)
      syncFocusLabels()
    }

    /**
     * The names that force their way through the collision grid: whatever the
     * cursor is on, and whatever is selected. Never more than two features, so
     * rebuilding the source outright is cheaper than reasoning about a diff.
     */
    const syncFocusLabels = () => {
      const src = map.getSource(SOURCE.focus) as GeoJSONSource | undefined
      if (!src) return
      const qids = [selectedRef.current, hovered.current].filter(
        (q, i, a): q is string => Boolean(q) && a.indexOf(q) === i
      )
      src.setData({
        type: 'FeatureCollection',
        features: qids.flatMap((qid) => {
          const p = byQidRef.current.get(qid)
          if (!p) return []
          return [
            {
              type: 'Feature' as const,
              geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
              properties: { name: p.name },
            },
          ]
        }),
      })
    }
    syncFocusRef.current = syncFocusLabels

    map.on('mousemove', (e) => {
      const id = dotAt(e.point)?.id
      setHover(id == null ? null : String(id))
    })
    map.on('mouseout', () => setHover(null))

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
      if (hit?.id != null) onSelectRef.current(String(hit.id))
    })

    // A tap has no hover to leave behind, and leaving one set would keep a name
    // and a lit dot on screen with nothing pointing at them.
    map.on('touchend', () => setHover(null))

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
      bound.current = null
      map.remove()
    }
  }, [])

  // ----- keeping it up to date -----

  useEffect(() => withMap(setDots), [dotsData])
  useEffect(() => withMap(setLinks), [linksData, linkMode])
  useEffect(() => withMap((map) => applyDotMode(map, dotMode)), [dotMode])

  const prevSelected = useRef<string | null>(null)
  useEffect(() => {
    withMap((map) => {
      if (prevSelected.current && prevSelected.current !== selectedQid) {
        map.setFeatureState({ source: SOURCE.dots, id: prevSelected.current }, { selected: false })
      }
      if (selectedQid) {
        map.setFeatureState({ source: SOURCE.dots, id: selectedQid }, { selected: true })
      }
      setActiveLinks(map)
      syncFocusRef.current?.()
    })
    prevSelected.current = selectedQid
  }, [selectedQid])

  // ----- camera -----

  useEffect(() => {
    if (!flyTo) return
    withMap((map) => {
      const center: [number, number] = [flyTo.lon, flyTo.lat]

      // A country wants to be framed, not magnified. Asking the camera what
      // would fit the box beats the old spread-to-scale heuristic, which had to
      // be retuned by hand every time the aspect ratio of the window changed.
      const framing =
        (flyTo.bounds && map.cameraForBounds(flyTo.bounds, { padding: 90 })?.zoom) ??
        flyTo.zoom ??
        null

      // A place wants a floor: if you have already zoomed past this, picking a
      // dot just centres it and leaves your zoom alone. Running down a list
      // therefore never yanks you back out — each row you pass either brings you
      // closer or leaves the zoom alone.
      const floor =
        flyTo.zoomBack != null && framing != null ? framing - flyTo.zoomBack : flyTo.zoomAtLeast

      const zoom =
        floor != null
          ? Math.max(map.getZoom(), floor)
          : (framing ?? map.getZoom())

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
  }, [flyTo])

  return <div ref={container} className="globe-canvas" />
}
