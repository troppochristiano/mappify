import { useEffect, useRef, useCallback, useMemo } from 'react'
import {
  geoOrthographic,
  geoPath,
  geoDistance,
  geoCentroid,
  type GeoPermissibleObjects,
} from 'd3-geo'
import { feature } from 'topojson-client'
import type { Topology } from 'topojson-specification'
import worldTopo from 'world-atlas/countries-110m.json'
import type { MapPoint, PlaceLink } from '../lib/api'

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
 */
export type FlyTarget = {
  lat: number
  lon: number
  zoom?: number
  zoomAtLeast?: number
  key?: string
}

/** Slack around a dot for clicks that just miss it. */
const NEAR_MISS = 10
/** Total pointer travel, in pixels, past which a press is a drag and not a click. */
const CLICK_SLOP = 6
const MIN_SCALE = 0.8
/**
 * How far in the globe will go.
 *
 * The coastlines come from a 110m atlas and turn visibly angular long before
 * this, but the dots do not: at street scale the point of zooming is to separate
 * places that overlap — the boroughs, the Bay Area, the dozen dots stacked on
 * London — and for that the map behind them is only backdrop.
 */
const MAX_SCALE = 1500

/**
 * How much one wheel notch changes the zoom.
 *
 * Multiplicative, so a notch means the same thing at every depth. At the old
 * 1.11 it took 65 notches to cross the range, which is a lot of scrolling to
 * separate two dots sitting on the same city — 1.18 crosses it in about 45.
 */
const ZOOM_STEP = 1.18
const LABEL_FONT = '600 11px system-ui, sans-serif'

/**
 * Country outlines, each with a bounding cap on the sphere.
 *
 * Drawing land is by far the most expensive thing in a frame — ~7.5ms of an
 * ~8.4ms drag frame, and the cost is per-vertex across all ~8,200 of them.
 * Roughly half belong to countries wholly on the far side of the planet, so
 * each feature carries the centre and angular radius of the smallest cap
 * containing it and one distance test rejects the lot, the same way dots are
 * already culled. Exact rather than approximate: a shape beyond the horizon
 * contributes nothing to the picture.
 *
 * Measured at 4% (7.76ms → 7.43ms, alternating frame by frame), which is far
 * less than the halving the vertex count suggests — d3-geo's own clip already
 * rejects backface segments fairly cheaply, so this only saves the walk itself.
 * Kept because it is exact and costs one distance test per country, but the
 * real fix for a still globe is the cached base layer in the component, not
 * this.
 */
const land = (() => {
  const topo = worldTopo as unknown as Topology
  const fc = feature(topo, topo.objects.countries) as unknown as {
    features: GeoPermissibleObjects[]
  }
  return fc.features.map((f) => {
    const centre = geoCentroid(f) as [number, number]
    let radius = 0
    // geoBounds is a lon/lat box and is wrong across the antimeridian and at the
    // poles, so the radius is measured against the vertices themselves.
    const walk = (co: unknown): void => {
      if (Array.isArray(co) && typeof co[0] === 'number') {
        const d = geoDistance(centre, co as [number, number])
        if (d > radius) radius = d
      } else if (Array.isArray(co)) co.forEach(walk)
    }
    walk((f as { geometry?: { coordinates?: unknown } }).geometry?.coordinates)
    return { f, centre, radius }
  })
})()

/**
 * How a dot carries "how much music is from here".
 *
 * `size` reads instantly but the biggest dots swallow their neighbours, which is
 * worst exactly where the data is densest. `colour` keeps every dot the same
 * target size — better for clicking and for seeing how many distinct places
 * there are — at the cost of needing a legend. `both` doubles the encoding.
 */
export type DotMode = 'size' | 'colour'

export const DOT_MODES: { id: DotMode; label: string }[] = [
  { id: 'size', label: 'size' },
  { id: 'colour', label: 'colour' },
]

const UNIFORM_R = 4.5

/**
 * How finely d3-geo subdivides coastline segments while the globe is moving.
 *
 * geoPath adaptively resamples every segment so a great-circle arc curves on
 * screen rather than cutting a straight chord. Loosening the tolerance to 4px
 * during motion is worth about 8% of the land cost (7.52ms → 6.92ms in an A/B
 * that alternated the setting frame by frame). Small, but free: it buys back
 * sub-pixel accuracy that nobody can see on geometry sliding past, and the
 * default (√0.5) returns the instant the globe settles.
 *
 * Worth recording what this is *not*: a first pass that changed the setting
 * between separate drags showed a 47% saving, which was an artefact — each
 * successive drag had rotated the globe further onto the Pacific, so the later
 * runs simply had less land on screen. Resampling was never the bottleneck.
 */
const DRAG_PRECISION = 4

/**
 * What the strings between places mean.
 *
 * `nesting` is containment — Brooklyn hanging off New York City — which is the
 * relation the browse menu walks, made visible on the map. `collabs` is who
 * recorded with whom. They answer different questions and overlaying both is
 * unreadable, so it is one or the other, or neither.
 */
export type LinkMode = 'nesting' | 'collabs' | 'none'

export const LINK_MODES: { id: LinkMode; label: string }[] = [
  { id: 'nesting', label: 'nesting' },
  { id: 'collabs', label: 'collabs' },
  { id: 'none', label: 'no links' },
]

/**
 * How a collaboration string is weighted by how many tracks it carries.
 *
 * There are ~730 of these and most are a single shared track, so drawing them
 * all at one weight is a hairball that hides the few that matter. Banding them
 * lets Chicago–Atlanta's 37 tracks read as a thread while a one-off stays a
 * whisper. Cool blue rather than the green of the dots: the strings are context,
 * and should never compete with the thing you are actually pointing at.
 */
const LINK_TIERS = [
  { min: 1, max: 3, stroke: 'rgba(125,180,235,.09)', width: 0.5 },
  { min: 3, max: 10, stroke: 'rgba(135,190,240,.20)', width: 0.7 },
  { min: 10, max: Infinity, stroke: 'rgba(150,205,255,.42)', width: 1.1 },
]

/**
 * Nesting strings get one weight, not a tiered one.
 *
 * There are only a few dozen and they carry no magnitude — a borough is inside
 * its city, and that is the whole statement. They are also short, joining dots
 * that already overlap, so they need to be brighter than a collaboration arc to
 * be visible at all at that length.
 */
const NEST_TIERS = [{ min: -Infinity, max: Infinity, stroke: 'rgba(160,210,255,.72)', width: 1.3 }]

/** The colour a string takes when it belongs to the place you have selected. */
const LINK_ACTIVE = 'rgba(30,215,96,.75)'

/**
 * Track counts are wildly skewed — one artist can hold 150 tracks while most
 * places hold one or two — so the ramp is logarithmic. A linear ramp would put
 * almost every place in the first colour.
 */
export function rampAt(t: number) {
  const stops = [
    [0.0, [40, 90, 60]],    // deep green: a single track
    [0.35, [29, 185, 84]],  // Spotify green
    [0.7, [190, 230, 120]], // lime
    [1.0, [255, 245, 180]], // pale gold: the densest places
  ] as const
  const x = Math.max(0, Math.min(1, t))
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [t0, c0] = stops[i - 1]
      const [t1, c1] = stops[i]
      const k = (x - t0) / (t1 - t0)
      return c0.map((c, j) => Math.round(c + (c1[j] - c) * k)) as unknown as number[]
    }
  }
  return stops[stops.length - 1][1] as unknown as number[]
}

type Box = { x: number; y: number; w: number; h: number }
type Placed = { p: MapPoint; x: number; y: number; r: number }

const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

/** Whether a dot overlaps a label box — nearest point on the box to the centre. */
function circleHitsBox(c: Placed, b: Box) {
  const nx = Math.max(b.x, Math.min(c.x, b.x + b.w))
  const ny = Math.max(b.y, Math.min(c.y, b.y + b.h))
  return Math.hypot(c.x - nx, c.y - ny) < c.r
}

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
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rotation = useRef<[number, number]>([0, -15])
  const scale = useRef(1)
  const velocity = useRef<[number, number]>([0, 0])
  const dragging = useRef(false)
  /** How far the pointer has travelled since it went down, to tell drags from clicks. */
  const dragDistance = useRef(0)
  const last = useRef<[number, number] | null>(null)
  const hovered = useRef<string | null>(null)
  const targetScale = useRef<number | null>(null)
  const pointer = useRef<[number, number] | null>(null)
  const renderRef = useRef<(() => void) | null>(null)
  /** Last frame's projected dots — what hit-testing runs against. */
  const visibleRef = useRef<Placed[]>([])

  const modeRef = useRef(dotMode)
  modeRef.current = dotMode

  /**
   * The busiest place in the library, cached.
   *
   * This used to be recomputed inside every per-dot call — `Math.max(...map())`
   * over every point, for every point, twice a frame. Measured at 2.06ms per
   * frame against 0.045ms hoisted, on a 16.7ms budget.
   */
  const maxTracks = useMemo(
    () => points.reduce((m, p) => (p.tracks > m ? p.tracks : m), 1),
    [points]
  )
  const maxRef = useRef(maxTracks)
  maxRef.current = maxTracks
  const logMax = Math.log(1 + maxTracks)

  /**
   * In `size` mode the radius grows with the square root of track count, so one
   * huge entry cannot swamp the map, and only weakly with zoom — that is what
   * lets a cluster separate into distinct dots as you zoom in.
   *
   * In `colour` mode every dot is the same size and magnitude moves to the fill,
   * which keeps click targets equal and makes the *number* of distinct places
   * legible rather than just the biggest ones.
   */
  const radiusOf = useCallback((p: MapPoint) => {
    const zoomBoost = Math.min(1.9, 0.75 + scale.current * 0.25)
    if (modeRef.current === 'colour') return UNIFORM_R * Math.min(1.6, zoomBoost)
    return 2 + Math.sqrt(p.tracks / maxRef.current) * 16 * zoomBoost
  }, [])

  /**
   * Position on the ramp, log-scaled. Counts run 1 to ~600 and are heavily
   * skewed, so a linear scale would leave almost every place in the first colour.
   */
  const rampPos = useCallback((tracks: number) => Math.log(1 + tracks) / logMax, [logMax])

  /** Text measurement is expensive and a place name never changes width. */
  const textWidths = useRef(new Map<string, number>())
  /** Set when something changed that the idle loop would otherwise not notice. */
  const dirty = useRef(true)
  /** The raw draw, used when a repaint must happen this tick rather than next. */
  const renderNow = useRef<(() => void) | null>(null)
  /**
   * When the rAF loop last ran, and when a paint last happened.
   *
   * rAF is throttled to nothing in a hidden or backgrounded tab and in some
   * embedded preview panes, where the loop simply never fires. Dragging still
   * has to work there, so input can drive the paint itself — but only when the
   * loop really is dead, and never faster than a display frame.
   */
  const loopAlive = useRef(0)
  const lastPaint = useRef(0)
  /**
   * The sphere and coastlines, kept as pixels.
   *
   * Land costs ~7.5ms a frame to project and it is the same picture for any two
   * frames at the same rotation, scale and size. Hovering a dot, selecting a
   * place, lighting a country, switching the dot encoding — none of them move
   * the map, yet each was redrawing every coastline from scratch. Blitting a
   * cached bitmap instead turns that into a copy.
   *
   * Only used when the globe is still. While it is turning the rotation differs
   * every frame, so the cache could never hit and the extra copy would only make
   * the drag slower.
   */
  const baseLayer = useRef<{ canvas: HTMLCanvasElement; key: string } | null>(null)
  const markDirty = useCallback(() => {
    dirty.current = true
    renderNow.current?.()
  }, [])
  const target = useRef<[number, number] | null>(null)
  const pointsRef = useRef(points)
  const litRef = useRef(litQids)
  const selectedRef = useRef(selectedQid)

  pointsRef.current = points
  litRef.current = litQids
  selectedRef.current = selectedQid

  const highlightRef = useRef(highlight)
  highlightRef.current = highlight

  const linksRef = useRef(links)
  linksRef.current = links
  const modeRefLink = useRef(linkMode)
  modeRefLink.current = linkMode

  // The strings live in the cached base layer, so the cache is stale the moment
  // they arrive — the key describes the camera, which has not moved.
  useEffect(() => {
    baseLayer.current = null
    markDirty()
  }, [links, linkMode, markDirty])

  useEffect(() => {
    if (!flyTo) return
    target.current = [-flyTo.lon, -flyTo.lat]
    // A country wants to be framed, not magnified — the caller says how close.
    if (flyTo.zoom) targetScale.current = flyTo.zoom
    else if (flyTo.zoomAtLeast && scale.current < flyTo.zoomAtLeast) {
      targetScale.current = flyTo.zoomAtLeast
    }
    markDirty()
  }, [flyTo])

  /**
   * Anything that changes the picture without touching the camera.
   *
   * The loop only draws when the globe is moving or something has marked itself
   * dirty, so a change that arrives while it sits still — a new point set from
   * the source filter, a search lighting different dots, a different encoding —
   * had no way to reach the canvas. It would keep showing the old picture until
   * you happened to drag or hover it back to life.
   */
  useEffect(() => {
    markDirty()
  }, [points, litQids, selectedQid, dotMode, highlight, markDirty])

  const projectionFor = useCallback((w: number, h: number, precision?: number) => {
    const p = geoOrthographic()
      .scale((Math.min(w, h) / 2.2) * scale.current)
      .translate([w / 2, h / 2])
      .rotate(rotation.current)
    if (precision !== undefined) p.precision(precision)
    return p
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    let frame = 0

    // render() is the whole picture; the rAF loop only re-runs it. Keeping them
    // separate means a first paint always lands, even where rAF is throttled to
    // nothing — a hidden/background tab, or an embedded preview pane.
    const render = () => {
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      // Before layout settles the element measures 0, and writing that to the
      // backing store leaves a permanently blank canvas if no later frame comes.
      if (!w || !h) return
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr
        canvas.height = h * dpr
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      // Ease toward a fly-to target, otherwise coast on drag inertia.
      // Zoom eases alongside the rotation, so framing a country is one motion.
      if (targetScale.current != null) {
        const d = targetScale.current - scale.current
        if (Math.abs(d) < 0.02) {
          scale.current = targetScale.current
          targetScale.current = null
        } else scale.current += d * 0.15
      }

      if (target.current) {
        const [tx, ty] = target.current
        const [rx, ry] = rotation.current
        const dx = ((tx - rx + 540) % 360) - 180
        const dy = ty - ry
        if (Math.abs(dx) < 0.4 && Math.abs(dy) < 0.4) target.current = null
        else rotation.current = [rx + dx * 0.12, ry + dy * 0.12]
      } else if (!dragging.current) {
        const [vx, vy] = velocity.current
        if (Math.abs(vx) > 0.01 || Math.abs(vy) > 0.01) {
          rotation.current = [rotation.current[0] + vx, rotation.current[1] + vy]
          velocity.current = [vx * 0.94, vy * 0.94]
        }
      }
      rotation.current[1] = Math.max(-80, Math.min(80, rotation.current[1]))

      // Whether the globe is actually in motion — dragging, coasting on inertia,
      // or flying to a target. Detail that cannot be seen mid-motion is dropped.
      const moving =
        dragging.current ||
        target.current !== null ||
        targetScale.current !== null ||
        Math.abs(velocity.current[0]) > 0.01 ||
        Math.abs(velocity.current[1]) > 0.01

      const projection = projectionFor(w, h, moving ? DRAG_PRECISION : undefined)
      const centre: [number, number] = [-rotation.current[0], -rotation.current[1]]

      /** Sphere and coastlines — everything that depends only on the camera. */
      const drawBase = (into: CanvasRenderingContext2D) => {
        const path = geoPath(projection, into)
        into.beginPath()
        path({ type: 'Sphere' })
        into.fillStyle = '#0b0b0b'
        into.fill()
        if (!moving) {
          into.strokeStyle = '#242424'
          into.lineWidth = 1
          into.stroke()
        }

        // Anything whose cap lies wholly beyond the horizon is skipped before a
        // single one of its vertices is touched.
        const horizon = Math.PI / 2
        into.beginPath()
        for (const { f, centre: c, radius } of land) {
          if (geoDistance(c, centre) - radius > horizon) continue
          path(f)
        }
        into.fillStyle = '#1c1c1c'
        into.fill()
        if (!moving) {
          into.strokeStyle = '#303030'
          into.lineWidth = 0.5
          into.stroke()
        }

        // Collaboration strings, drawn under the dots so they read as threads
        // between places rather than as anything you can click.
        //
        // A LineString between two points is a great circle to d3-geo, so these
        // curve over the sphere and clip themselves at the horizon for free.
        // Batched into three weights: 727 separate strokes would be 727 state
        // changes, three is three. Skipped entirely while the globe is moving,
        // like the coastline outlines — this is the layer you read when still.
        if (!moving && linksRef.current.length) {
          for (const tier of modeRefLink.current === 'nesting' ? NEST_TIERS : LINK_TIERS) {
            into.beginPath()
            let any = false
            for (const l of linksRef.current) {
              // Nesting links carry no track count, and their single tier spans
              // everything, so the band test passes them through untouched.
              const weight = l.tracks ?? 1
              if (weight < tier.min || weight >= tier.max) continue
              path({
                type: 'LineString',
                coordinates: [
                  [l.alon, l.alat],
                  [l.blon, l.blat],
                ],
              } as unknown as GeoPermissibleObjects)
              any = true
            }
            if (!any) continue
            into.strokeStyle = tier.stroke
            into.lineWidth = tier.width
            into.stroke()
          }
        }
      }

      if (moving) {
        // Every frame is a different rotation, so caching could only ever miss.
        drawBase(ctx)
      } else {
        const key = `${canvas.width}x${canvas.height}|${rotation.current[0].toFixed(4)},${rotation.current[1].toFixed(4)}|${scale.current.toFixed(5)}`
        let base = baseLayer.current
        if (!base || base.key !== key) {
          const off = base?.canvas ?? document.createElement('canvas')
          off.width = canvas.width
          off.height = canvas.height
          const octx = off.getContext('2d')!
          octx.setTransform(dpr, 0, 0, dpr, 0, 0)
          octx.clearRect(0, 0, w, h)
          drawBase(octx)
          base = { canvas: off, key }
          baseLayer.current = base
        }
        ctx.drawImage(base.canvas, 0, 0, w, h)
      }

      // The strings belonging to whatever you are pointing at, lifted out of the
      // faint mass beneath. Drawn per frame rather than baked into the cache
      // because they follow the selection, which changes without the camera
      // moving — and there are only ever a handful.
      const focus = selectedRef.current ?? hovered.current
      if (focus && !moving && linksRef.current.length) {
        const linkPath = geoPath(projection, ctx)
        ctx.beginPath()
        let any = false
        for (const l of linksRef.current) {
          if (l.a !== focus && l.b !== focus) continue
          linkPath({
            type: 'LineString',
            coordinates: [
              [l.alon, l.alat],
              [l.blon, l.blat],
            ],
          } as unknown as GeoPermissibleObjects)
          any = true
        }
        if (any) {
          ctx.strokeStyle = LINK_ACTIVE
          ctx.lineWidth = 1.2
          ctx.stroke()
        }
      }

      const lit = litRef.current
      // Visible points, projected once and reused for drawing, labelling and
      // hit-testing, so what you can click is exactly what you can see.
      const visible = []
      for (const p of pointsRef.current) {
        // Backface culling — without it, dots on the far side draw through the planet.
        if (geoDistance([p.lon, p.lat], centre) > Math.PI / 2) continue
        const xy = projection([p.lon, p.lat])
        if (!xy) continue
        visible.push({ p, x: xy[0], y: xy[1], r: radiusOf(p) })
      }
      visibleRef.current = visible

      // Big dots first, so a small one is drawn on top and stays clickable.
      visible.sort((a, b) => b.r - a.r)

      // A highlight from the menu behaves like a spotlight: everything outside
      // it recedes so the country reads as a shape rather than as scattered
      // brighter dots among equally bright ones.
      const spot = highlightRef.current
      for (const v of visible) {
        const isSelected = v.p.qid === selectedRef.current
        const inSpot = Boolean(spot?.has(v.p.qid))
        const isHovered = v.p.qid === hovered.current || inSpot
        const isLit = (!lit || lit.has(v.p.qid)) && (!spot || inSpot)

        ctx.beginPath()
        ctx.arc(v.x, v.y, v.r, 0, Math.PI * 2)
        if (isSelected) {
          ctx.fillStyle = 'rgba(255,255,255,.95)'
          ctx.strokeStyle = '#fff'
        } else if (isLit && modeRef.current === 'colour') {
          const [r, g, b] = rampAt(rampPos(v.p.tracks))
          ctx.fillStyle = `rgba(${r},${g},${b},${isHovered ? 1 : 0.85})`
          ctx.strokeStyle = `rgb(${r},${g},${b})`
        } else if (isLit) {
          ctx.fillStyle = isHovered ? 'rgba(30,215,96,.9)' : 'rgba(29,185,84,.5)'
          ctx.strokeStyle = '#1ed760'
        } else {
          ctx.fillStyle = 'rgba(120,120,120,.12)'
          ctx.strokeStyle = 'rgba(150,150,150,.25)'
        }
        ctx.lineWidth = isSelected || isHovered ? 1.6 : 0.8
        ctx.fill()
        ctx.stroke()
      }

      // Labels, densest-first, skipping any that would collide with a label
      // already placed or with another dot. Zooming in frees space, so names
      // appear progressively rather than by a fixed popularity cut-off.
      // Labels are the expensive pass — an all-pairs collision test plus text
      // rendering — and they are unreadable mid-drag anyway. Skipping them while
      // the globe is actually moving is where the frame budget comes back.
      if (moving) {
        lastPaint.current = performance.now()
        return
      }

      ctx.font = LABEL_FONT
      const placed: Box[] = []
      const byWeight = [...visible].sort((a, b) => b.p.tracks - a.p.tracks)
      for (const v of byWeight) {
        const isSelected = v.p.qid === selectedRef.current
        // Only a dot the cursor is genuinely on forces its label through. A
        // whole-country spotlight must not, or Italy would draw 22 overlapping
        // names at once.
        const isHovered = v.p.qid === hovered.current
        if (lit && !lit.has(v.p.qid) && !isSelected) continue
        // Outside the spotlight, names go quiet along with the dots.
        if (spot && !spot.has(v.p.qid) && !isSelected) continue

        let width = textWidths.current.get(v.p.name)
        if (width === undefined) {
          width = ctx.measureText(v.p.name).width
          textWidths.current.set(v.p.name, width)
        }
        const box = { x: v.x + v.r + 4, y: v.y - 7, w: width, h: 14 }

        // A hovered or selected dot always gets its name, even in a crowd.
        if (!isSelected && !isHovered) {
          if (box.x + box.w > w || box.y < 0 || box.y + box.h > h) continue
          if (placed.some((q) => intersects(q, box))) continue
          // A dimmed dot should not veto a spotlit name — only dots that are
          // themselves visible can get in the way.
          if (
            visible.some(
              (o) => o !== v && (!spot || spot.has(o.p.qid)) && circleHitsBox(o, box)
            )
          )
            continue
        }
        placed.push(box)

        ctx.fillStyle = isSelected || isHovered ? '#fff' : 'rgba(255,255,255,.62)'
        if (isSelected || isHovered) {
          // A dark plate keeps the name readable over land or another dot.
          ctx.fillStyle = 'rgba(0,0,0,.55)'
          ctx.fillRect(box.x - 3, box.y - 1, box.w + 6, box.h + 2)
          ctx.fillStyle = '#fff'
        }
        ctx.fillText(v.p.name, box.x, v.y + 4)
      }
      lastPaint.current = performance.now()
    }

    /**
     * Only draw when something is actually moving.
     *
     * The loop used to repaint 60 times a second forever — projecting 177
     * country outlines and every dot — even with the globe sitting perfectly
     * still. That is the idle cost that made the whole page feel heavy.
     */
    let wasMoving = false
    const loop = () => {
      loopAlive.current = performance.now()
      const [vx, vy] = velocity.current
      const moving =
        dragging.current ||
        target.current !== null ||
        targetScale.current !== null ||
        Math.abs(vx) > 0.01 ||
        Math.abs(vy) > 0.01
      // Motion frames are drawn at reduced detail — coarse coastlines, no
      // outlines, no labels. So the frame where motion ends has to be redrawn at
      // full detail, or the globe would come to rest on a stripped-down picture.
      if (wasMoving && !moving) dirty.current = true
      wasMoving = moving
      if (moving || dirty.current) {
        dirty.current = false
        render()
      }
      frame = requestAnimationFrame(loop)
    }

    render() // paint immediately, before any frame is scheduled
    renderRef.current = render
    renderNow.current = render
    frame = requestAnimationFrame(loop)

    // Timers still fire where rAF and ResizeObserver are throttled to nothing,
    // so these are the fallback that guarantees a first paint once the element
    // has actually been laid out.
    const retries = [0, 50, 250].map((ms) => window.setTimeout(render, ms))

    // A resize changes the canvas backing store, which clears it; repaint at
    // once rather than waiting for a frame that may never come.
    const observer = new ResizeObserver(() => render())
    observer.observe(canvas)

    return () => {
      cancelAnimationFrame(frame)
      retries.forEach(window.clearTimeout)
      observer.disconnect()
      renderRef.current = null
    }
  }, [projectionFor, radiusOf])

  // Props that change the picture but not the motion still need a repaint when
  // the animation loop is throttled.
  useEffect(() => {
    markDirty()
  }, [points, litQids, selectedQid, dotMode])

  // ----- interaction -----

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    dragging.current = true
    dragDistance.current = 0
    last.current = [e.clientX, e.clientY]
    velocity.current = [0, 0]
    target.current = null
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.classList.add('dragging')
  }

  /**
   * The dot under a canvas position.
   *
   * Runs against what was actually drawn, and prefers the *smallest* circle
   * containing the point: where a small dot overlaps a large one, the small one
   * is drawn on top and is the harder of the two to hit any other way, so
   * nearest-centre would make it permanently unclickable. Only when nothing
   * contains the point does it fall back to the nearest within a small slack.
   */
  const pointAt = (px: number, py: number) => {
    const lit = litRef.current
    let contained: Placed | null = null
    let nearest: Placed | null = null
    let nearestD = Infinity

    for (const v of visibleRef.current) {
      if (lit && !lit.has(v.p.qid)) continue
      const d = Math.hypot(v.x - px, v.y - py)
      if (d <= v.r) {
        if (!contained || v.r < contained.r) contained = v
      } else if (d - v.r < nearestD) {
        nearestD = d - v.r
        nearest = v
      }
    }
    if (contained) return contained.p
    return nearest && nearestD <= NEAR_MISS ? nearest.p : null
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget
    const rect = canvas.getBoundingClientRect()
    pointer.current = [e.clientX - rect.left, e.clientY - rect.top]

    if (!dragging.current) {
      const over = pointAt(pointer.current[0], pointer.current[1])
      canvas.style.cursor = over ? 'pointer' : ''
      const next = over?.qid ?? null
      if (next !== hovered.current) {
        hovered.current = next
        onHover(next)
        markDirty()
      }
      return
    }
    if (!last.current) return
    const [lx, ly] = last.current
    dragDistance.current += Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly)
    const k = 0.28 / scale.current
    const dx = (e.clientX - lx) * k
    const dy = (e.clientY - ly) * k
    rotation.current = [rotation.current[0] + dx, rotation.current[1] - dy]
    velocity.current = [dx * 0.5, -dy * 0.5]
    last.current = [e.clientX, e.clientY]

    // Deliberately not markDirty(). That paints synchronously, and a mouse
    // reporting at 125Hz would then force ~125 full redraws a second on top of
    // the ones the loop is already doing — frames past the refresh rate that
    // nobody sees, but that still block the main thread, so pointer events queue
    // up behind them and the drag itself goes heavy. The loop already redraws
    // every frame while the globe is moving, so recording the rotation is enough.
    dirty.current = true
    const now = performance.now()
    if (now - loopAlive.current > 100 && now - lastPaint.current > 12) {
      // No loop to defer to — drive the paint from the input instead.
      renderNow.current?.()
    }
  }

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    dragging.current = false
    last.current = null
    e.currentTarget.classList.remove('dragging')

    // Without a loop there is nothing to animate the inertia, and nothing to
    // draw the full-detail frame once it has decayed — the globe would be left
    // resting on a motion frame, with no coastline outlines and no labels. So
    // where the loop is dead, let go of the throw and settle immediately.
    if (performance.now() - loopAlive.current > 100) {
      velocity.current = [0, 0]
      markDirty()
    }
  }

  /**
   * Selection happens here and nowhere else. Dragging used to re-select
   * continuously as places passed under the screen centre, which meant the
   * playing track changed while you were only trying to look around.
   */
  const onClick = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // A click still fires after a drag, so letting go of the globe with the
    // cursor over a dot used to select that dot — you spun the world and it
    // tuned into wherever your hand happened to stop. Only a pointer that
    // barely moved counts as a click on something.
    if (dragDistance.current > CLICK_SLOP) return
    const rect = e.currentTarget.getBoundingClientRect()
    const point = pointAt(e.clientX - rect.left, e.clientY - rect.top)
    if (!point) return
    onSelect(point.qid)
  }

  /**
   * Zooms toward the cursor: the geographic point under the pointer stays put,
   * so you can magnify a cluster without first dragging it to the middle.
   */
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget
    const rect = canvas.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top

    const before = projectionFor(canvas.clientWidth, canvas.clientHeight).invert?.([px, py])
    scale.current = Math.max(
      MIN_SCALE,
      Math.min(MAX_SCALE, scale.current * (e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP))
    )
    const after = projectionFor(canvas.clientWidth, canvas.clientHeight).invert?.([px, py])

    // rotate() takes the negated centre, so the correction runs opposite to the
    // drift: the geographic point that was under the cursor is put back there.
    if (before && after) {
      rotation.current = [
        rotation.current[0] + (after[0] - before[0]),
        Math.max(-80, Math.min(80, rotation.current[1] + (after[1] - before[1]))),
      ]
    }
    target.current = null
    markDirty()
  }

  return (
    <canvas
      ref={canvasRef}
      className="globe-canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={onClick as unknown as React.MouseEventHandler<HTMLCanvasElement>}
      onWheel={onWheel}
    />
  )
}
