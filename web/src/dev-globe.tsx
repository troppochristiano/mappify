/**
 * A harness for the globe, with no server and no sign-in behind it.
 *
 * The real route needs a Spotify session and a library import before a single
 * dot exists, which makes the label behaviour — a thing about collision and
 * hover — unreachable for a check. This mounts the actual <Globe> with points
 * made up on the spot: a few places alone in an ocean, whose names the
 * placement engine will certainly draw, and a knot of them on top of each other
 * in London, where most names will be squeezed out.
 *
 * Dev only. Not imported by the app, and not in the production bundle.
 */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Map as MapLibreMap } from 'maplibre-gl'
import { Globe } from './components/Globe'
import type { MapPoint } from './lib/api'

// The component owns its map and never hands it out, which is right for the
// app and useless for a check. getSource is called on every data push, so the
// first one hands the instance over.
const getSource = MapLibreMap.prototype.getSource
MapLibreMap.prototype.getSource = function (id: string) {
  ;(window as unknown as { map: MapLibreMap }).map = this
  return getSource.call(this, id)
}

const place = (qid: string, name: string, lat: number, lon: number, tracks: number): MapPoint => ({
  qid,
  name,
  lat,
  lon,
  country_iso: null,
  parent_qid: null,
  tracks,
  artists: Math.max(1, Math.round(tracks / 3)),
})

const ALONE: MapPoint[] = [
  place('Q1', 'Reykjavik', 64.15, -21.94, 40),
  place('Q2', 'Perth', -31.95, 115.86, 30),
  place('Q3', 'Honolulu', 21.31, -157.86, 25),
  place('Q4', 'Ushuaia', -54.8, -68.3, 20),
]

// Twelve names inside a tenth of a degree: at world view the collision grid can
// only draw one or two of them.
const CROWD: MapPoint[] = Array.from({ length: 12 }, (_, i) =>
  place(
    `Q1${i}`,
    ['Camden', 'Hackney', 'Lambeth', 'Brixton', 'Soho', 'Peckham', 'Islington', 'Shoreditch',
      'Fulham', 'Chelsea', 'Greenwich', 'Deptford'][i],
    51.5 + (i % 4) * 0.03,
    -0.12 + Math.floor(i / 4) * 0.03,
    60 - i * 4
  )
)

const POINTS = [...ALONE, ...CROWD]

function Harness() {
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <Globe
      points={POINTS}
      litQids={null}
      selectedQid={selected}
      onSelect={setSelected}
      onHover={() => {}}
      flyTo={null}
      dotMode="size"
      links={[]}
      linkMode="none"
    />
  )
}

createRoot(document.getElementById('root')!).render(<Harness />)

// ----- the check -----
//
// Written into the DOM rather than logged, because the tooling reading this
// page cannot see the page's own JavaScript globals — only its markup.

const report = (o: unknown) => {
  const el = document.getElementById('report') ?? document.createElement('pre')
  el.id = 'report'
  el.style.cssText = 'position:absolute;z-index:9;left:8px;top:8px;color:#0f0;font:11px monospace'
  el.textContent = JSON.stringify(o, null, 1)
  document.body.appendChild(el)
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * What the map is drawing, and what it thinks.
 *
 * `verdict` is the whole rule in one line: a name that is on screen must not
 * also be forced, and a name that is not on screen must be, or pointing at its
 * dot tells you nothing.
 */
const snapshot = (map: MapLibreMap) => {
  const placed = map
    .queryRenderedFeatures({ layers: ['labels'] })
    .map((f) => f.properties.name as string)
  // What the focus layer actually drew, not what its source was handed —
  // asking the source means trusting the wrapper MapLibre keeps its data in.
  const forced = map
    .queryRenderedFeatures({ layers: ['focus-labels'] })
    .map((f) => f.properties.name as string)
  const state = (qid: string) => map.getFeatureState({ source: 'dots', id: qid })
  const hovered = POINTS.find((p) => state(p.qid).hover) ?? null
  const marked = POINTS.filter((p) => state(p.qid).forced).map((p) => p.name)
  const ownLabelUp = hovered ? placed.includes(hovered.name) : null
  return {
    hovered: hovered?.name ?? null,
    ownLabelUp,
    forced,
    marked,
    placed: [...placed].sort(),
    verdict:
      hovered == null
        ? forced.length === 0
          ? 'ok: nothing pointed at, nothing forced'
          : `WRONG: forcing ${forced} with no hover`
        : ownLabelUp
          ? forced.includes(hovered.name)
            ? 'WRONG: name is on screen and forced as well — doubled'
            : 'ok: on-screen name left alone'
          : forced.includes(hovered.name)
            ? 'ok: hidden name forced through'
            : 'WRONG: name is hidden and not forced — nothing to read',
  }
}

/** Put the pointer on a place, the way a hand would. */
const hover = (map: MapLibreMap, p: MapPoint) => {
  const at = map.project([p.lon, p.lat])
  const box = map.getCanvas().getBoundingClientRect()
  map.getCanvasContainer().dispatchEvent(
    new MouseEvent('mousemove', {
      bubbles: true,
      clientX: box.left + at.x,
      clientY: box.top + at.y,
    })
  )
}

async function run() {
  // The map is built in an effect, so it does not exist at module time.
  let map: MapLibreMap | undefined
  for (let i = 0; i < 100 && !map; i++) {
    map = (window as unknown as { map?: MapLibreMap }).map
    if (!map) await wait(100)
  }
  if (!map) return report({ error: 'no map' })
  await wait(1500)

  const out: Record<string, unknown> = {}
  out.atRest = snapshot(map)

  // 1. A place with its own name on screen: no forced copy.
  hover(map, ALONE[0])
  await wait(600)
  out.hoverAlone = snapshot(map)

  // 2. A place in the knot, whose name the grid had no room for.
  hover(map, CROWD[6])
  await wait(600)
  out.hoverCrowd = snapshot(map)

  // 3. Pointer off everything: nothing forced, nothing left marked.
  hover(map, { ...ALONE[0], lat: 0, lon: -30 })
  await wait(600)
  out.hoverNothing = snapshot(map)

  // 4. The same knot from close in, where the names have room. What was forced
  //    a moment ago should have handed its slot back.
  map.jumpTo({ center: [CROWD[6].lon, CROWD[6].lat], zoom: 11 })
  await wait(1200)
  hover(map, CROWD[6])
  await wait(1200)
  out.hoverCrowdZoomedIn = snapshot(map)

  // 5. Does `forced` actually reach the symbol layer? Counting the lit pixels
  //    around a name with the state off and then on answers it in the only
  //    terms that matter — if the text does not go away, the forced copy lands
  //    beside it and the place is named twice, which is the bug being fixed.
  hover(map, { ...ALONE[0], lat: 0, lon: -30 })
  await wait(400)
  const lit = () => {
    const gl = map.getCanvas()
    const at = map.project([CROWD[6].lon, CROWD[6].lat])
    const dpr = gl.width / gl.clientWidth
    const box = { x: (at.x - 90) * dpr, y: (at.y - 20) * dpr, w: 180 * dpr, h: 40 * dpr }
    const off = document.createElement('canvas')
    off.width = gl.width
    off.height = gl.height
    const ctx = off.getContext('2d')!
    ctx.drawImage(gl, 0, 0)
    const px = ctx.getImageData(box.x, box.y, box.w, box.h).data
    let n = 0
    let brightest = 0
    // Label text is near-white — .78 alpha over a dark ground, so about 200 —
    // while the imagery under it at this zoom is not.
    for (let i = 0; i < px.length; i += 4) {
      const v = Math.min(px[i], px[i + 1], px[i + 2])
      if (v > brightest) brightest = v
      if (v > 150) n++
    }
    return { n, brightest, box: [Math.round(box.x), Math.round(box.y), box.w, box.h] }
  }
  const before = lit()
  map.setFeatureState({ source: 'dots', id: CROWD[6].qid }, { forced: true })
  await wait(600)
  const after = lit()
  map.setFeatureState({ source: 'dots', id: CROWD[6].qid }, { forced: false })
  out.labelStandsDown = {
    litPixelsBefore: before,
    litPixelsAfter: after,
    verdict:
      before > 40 && after < before / 4
        ? 'ok: feature state reaches the symbol layer, the name goes away'
        : 'WRONG: the name is still drawn — a forced copy would double it',
  }

  report(out)
}

void run()
