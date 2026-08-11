import type {
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
  LayerSpecification,
  Map,
  StyleSpecification,
} from 'maplibre-gl'
import { rampAt } from './ramp'
import type { DotMode, LinkMode } from './ramp'

/**
 * Everything the map is made of, as data.
 *
 * The canvas globe drew its picture procedurally, which meant the rules for how
 * a dot looked were spread across a 200-line loop. Here they are style
 * expressions, evaluated on the GPU, and they live in one file so the whole
 * appearance of the globe can be read in one sitting.
 */

export const SOURCE = {
  earth: 'earth',
  coast: 'coast',
  links: 'links',
  dots: 'dots',
  focus: 'focus',
} as const

export const LAYER = {
  space: 'space',
  earth: 'earth',
  coast: 'coast',
  links: 'links',
  linksActive: 'links-active',
  dots: 'dots',
  labels: 'labels',
  focusLabels: 'focus-labels',
} as const

/** Deep space, behind and around the planet. */
const SPACE = '#08080a'

const SELECTED = 'rgba(255,255,255,.95)'
const DOT_GREEN = 'rgba(29,185,84,.5)'
const DOT_GREEN_HOT = 'rgba(30,215,96,.9)'
const DOT_STROKE = '#1ed760'
const DIM_FILL = 'rgba(120,120,120,.12)'
const DIM_STROKE = 'rgba(150,150,150,.25)'

/** The colour a string takes when it belongs to the place you have selected. */
const LINK_ACTIVE = 'rgba(30,215,96,.75)'

/** Uniform dot size in colour mode, where magnitude has moved to the fill. */
const UNIFORM_R = 4.5

const state = (key: string): ExpressionSpecification => [
  'boolean',
  ['feature-state', key],
  false,
]

/** Either of the two things that mean "this is the dot you are dealing with". */
const focused: ExpressionSpecification = ['any', state('hover'), state('selected')]

/**
 * The track→colour ramp, handed to the GPU as interpolation stops.
 *
 * Generated from `rampAt` rather than restated, because the legend in the route
 * draws its swatches from the same function — restating the stops here is how
 * the two quietly stop matching.
 */
function rampStops(alpha: number): ExpressionSpecification {
  const stops: (number | string)[] = []
  for (let i = 0; i <= 8; i++) {
    const t = i / 8
    const [r, g, b] = rampAt(t)
    stops.push(t, `rgba(${r},${g},${b},${alpha})`)
  }
  return ['interpolate', ['linear'], ['get', 'weight'], ...stops] as ExpressionSpecification
}

/**
 * How big a dot is.
 *
 * In `size` mode the radius grows with the square root of the track count and
 * only weakly with zoom — that weak growth is what lets a cluster separate into
 * distinct dots as you go in. In `colour` mode every dot is the same size, which
 * keeps click targets equal and makes the *number* of distinct places legible
 * rather than just the biggest ones.
 *
 * The zoom curve reproduces the canvas globe's `min(1.9, 0.75 + scale * 0.25)`.
 * Translating it is not simply z = log2(scale): the old scale was 1 when the
 * planet filled the window, and the zoom that does that here is about 2.2 — so
 * the whole curve is anchored there rather than at zero, which is the difference
 * between dots that look right at world view and dots that arrive already at
 * their largest.
 */
const FILL_Z = 2.2
export function circleRadius(mode: DotMode): DataDrivenPropertyValueSpecification<number> {
  const grow = (k: number): ExpressionSpecification =>
    mode === 'colour'
      ? ['literal', UNIFORM_R * Math.min(1.6, k)]
      : ['+', 2, ['*', ['get', 'size'], 16 * k]]
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    FILL_Z, grow(1.0),
    FILL_Z + 1, grow(1.25),
    FILL_Z + 2.2, grow(1.9),
    22, grow(1.9),
  ] as DataDrivenPropertyValueSpecification<number>
}

/**
 * A selected dot is white, a dimmed one recedes, and otherwise magnitude is
 * either in the fill (colour mode) or in the radius (size mode). Order matters:
 * selection wins over everything, dimming loses to it.
 */
export function circleColor(mode: DotMode): DataDrivenPropertyValueSpecification<string> {
  const normal = mode === 'colour' ? rampStops(0.85) : DOT_GREEN
  const hot = mode === 'colour' ? rampStops(1) : DOT_GREEN_HOT
  return [
    'case',
    state('selected'), SELECTED,
    ['get', 'dim'], DIM_FILL,
    focused, hot,
    normal,
  ] as DataDrivenPropertyValueSpecification<string>
}

export function circleStrokeColor(mode: DotMode): DataDrivenPropertyValueSpecification<string> {
  const normal = mode === 'colour' ? rampStops(1) : DOT_STROKE
  return [
    'case',
    state('selected'), '#fff',
    ['get', 'dim'], DIM_STROKE,
    normal,
  ] as DataDrivenPropertyValueSpecification<string>
}

const STROKE_WIDTH: DataDrivenPropertyValueSpecification<number> = [
  'case',
  ['any', state('selected'), state('hover')], 1.6,
  0.8,
]

/**
 * Link weight, as one ramp instead of three bands.
 *
 * The canvas globe batched links into three stroke tiers because 727 separate
 * strokes meant 727 canvas state changes. On the GPU they are one draw either
 * way, so the banding can go and the weighting can be continuous —
 * Chicago–Atlanta's 37 tracks reads as a thread while a one-off stays a whisper,
 * with nothing to fall between bands.
 */
function linkPaint(mode: LinkMode) {
  if (mode === 'nesting') {
    // A borough is inside its city, and that is the whole statement — no
    // magnitude to encode. They are also short, joining dots that already
    // overlap, so they have to be brighter than a collaboration arc to be
    // visible at that length.
    return {
      'line-color': 'rgba(160,210,255,.72)',
      'line-width': 1.3,
    }
  }
  return {
    'line-color': [
      'interpolate', ['linear'], ['get', 'tracks'],
      1, 'rgba(125,180,235,.09)',
      3, 'rgba(135,190,240,.20)',
      10, 'rgba(150,205,255,.42)',
    ] as DataDrivenPropertyValueSpecification<string>,
    'line-width': [
      'interpolate', ['linear'], ['get', 'tracks'],
      1, 0.5,
      3, 0.7,
      10, 1.1,
    ] as DataDrivenPropertyValueSpecification<number>,
  }
}

const LABEL_FONT = ['Noto Sans Regular']
const LABEL_FONT_FOCUS = ['Noto Sans Medium']

/**
 * Where a name sits relative to its dot.
 *
 * The canvas version could only put labels to the right, and dropped any that
 * collided. Letting the placement engine try the other sides first means a name
 * that would have been discarded now finds room — the same rule, with more
 * places to put things.
 */
const LABEL_PLACEMENT = {
  'text-font': LABEL_FONT,
  'text-size': 11,
  'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
  'text-radial-offset': 0.75,
  'text-justify': 'auto',
  'text-max-width': 9,
} as const

const LABEL_PAINT = {
  'text-color': 'rgba(255,255,255,.78)',
  // A halo rather than the canvas version's dark plate: over imagery a name has
  // to survive being on snow as well as on ocean, and a plate large enough to
  // do that reads as a box floating over the map.
  'text-halo-color': 'rgba(0,0,0,.8)',
  'text-halo-width': 1.2,
  'text-halo-blur': 0.4,
} as const

export function buildStyle(glyphs: string, tiles: string, maxzoom: number): StyleSpecification {
  return {
    version: 8,
    glyphs,
    // Declared in the style rather than set on the map afterwards: setProjection
    // throws if the style has not finished loading, and at construction it never
    // has.
    projection: { type: 'globe' },
    // Attribution is rendered in the app's own About panel, not as a map overlay.
    sources: {
      [SOURCE.earth]: {
        type: 'raster',
        tiles: [tiles],
        tileSize: 512,
        // Past this the imagery is overzoomed rather than absent — MapLibre
        // keeps drawing the deepest tile it has, which is what makes zooming
        // past the pyramid a softening rather than a hole.
        maxzoom,
        // Keep tiles rather than evicting them, so spinning back to a region is
        // instant instead of a re-download.
        volatile: false,
      },
      [SOURCE.coast]: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      [SOURCE.links]: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      [SOURCE.dots]: {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        // Feature ids have to survive the trip through the worker, and a
        // top-level `id` does not: GeoJSON sources are encoded as vector tiles,
        // where ids are numeric, so a string id silently becomes 0 — every dot
        // identical, feature-state landing on all of them at once, and every
        // click reporting the same place. `promoteId` is how a string key
        // travels, and qid is what the rest of the app already identifies a
        // place by.
        promoteId: 'qid',
      },
      [SOURCE.focus]: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers: [
      { id: LAYER.space, type: 'background', paint: { 'background-color': SPACE } },
      {
        id: LAYER.earth,
        type: 'raster',
        source: SOURCE.earth,
        paint: {
          // Blue Marble is bright, and the dots are a mid green. Pulling the
          // highlights down and the saturation back is what keeps a dot over
          // Greenland as legible as one over the Atlantic.
          //
          // Only at world view, though. That is where a hundred dots compete
          // with snow and cloud; once you are down at a city there are a handful
          // of dots on screen, they are large, and dimming the ground under them
          // buys nothing — it just makes an already soft, overzoomed image look
          // like mud. So the treatment lifts as you go in.
          'raster-brightness-max': ['interpolate', ['linear'], ['zoom'], 5, 0.78, 8, 1],
          'raster-saturation': ['interpolate', ['linear'], ['zoom'], 5, -0.15, 8, 0],
          'raster-fade-duration': 180,
        },
      },
      {
        id: LAYER.coast,
        type: 'line',
        source: SOURCE.coast,
        paint: {
          'line-color': 'rgba(255,255,255,.5)',
          'line-width': 0.6,
          // Invisible while the imagery still has detail of its own, and only
          // fading in past the bottom of the tile pyramid, where the photo goes
          // soft and a coastline is the only thing left to navigate by.
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 5.5, 0, 8.5, 0.5],
        },
      },
      {
        id: LAYER.links,
        type: 'line',
        source: SOURCE.links,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: linkPaint('collabs'),
      },
      {
        id: LAYER.linksActive,
        type: 'line',
        source: SOURCE.links,
        // Nothing selected: match nothing. Replaced by setFilter on selection.
        filter: ['==', ['get', 'a'], ' '],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': LINK_ACTIVE, 'line-width': 1.2 },
      },
      {
        id: LAYER.dots,
        type: 'circle',
        source: SOURCE.dots,
        paint: {
          'circle-radius': circleRadius('size'),
          'circle-color': circleColor('size'),
          'circle-stroke-color': circleStrokeColor('size'),
          'circle-stroke-width': STROKE_WIDTH,
        },
      },
      {
        id: LAYER.labels,
        type: 'symbol',
        source: SOURCE.dots,
        // Quietened dots lose their names outright rather than fading, so the
        // space they were occupying goes back to the names that are still lit.
        filter: ['!', ['get', 'dim']],
        layout: {
          ...LABEL_PLACEMENT,
          'text-field': ['get', 'name'],
          // Densest first, so when two names compete the busier place keeps its
          // label — the same rule the canvas collision loop used, and the reason
          // names appear progressively as zooming frees up room.
          'symbol-sort-key': ['-', 0, ['get', 'tracks']],
        },
        paint: {
          ...LABEL_PAINT,
          // Stand down for whatever the focus layer is about to draw, or the
          // name appears twice — once placed by the collision grid and once
          // forced through on top of it.
          //
          // Hidden rather than filtered out. A filter would drop the feature
          // from the layer entirely, freeing the slot it was holding, and every
          // name around it would shuffle to fill the gap — so pointing at a dot
          // would rearrange the map. Going transparent keeps the slot reserved,
          // which is what makes the swap invisible. It also costs nothing:
          // paint properties read feature state without re-laying out symbols,
          // and layout properties like text-allow-overlap cannot read it at all,
          // which is why the forced label needs its own layer in the first place.
          'text-opacity': ['case', focused, 0, 1],
        },
      },
      {
        id: LAYER.focusLabels,
        type: 'symbol',
        source: SOURCE.focus,
        layout: {
          ...LABEL_PLACEMENT,
          'text-font': LABEL_FONT_FOCUS,
          'text-field': ['get', 'name'],
          // Whatever you are pointing at always gets its name, even in a crowd.
          // Its own source rather than the dots layer, because only the *one*
          // dot under the cursor may force its way through: a whole-country
          // spotlight doing this would draw 22 overlapping names across Italy.
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: { ...LABEL_PAINT, 'text-color': '#fff', 'text-halo-width': 1.6 },
      },
    ] as LayerSpecification[],
  }
}

/** Repaint the dots for a different encoding. No source change, no re-upload. */
export function applyDotMode(map: Map, mode: DotMode) {
  map.setPaintProperty(LAYER.dots, 'circle-radius', circleRadius(mode))
  map.setPaintProperty(LAYER.dots, 'circle-color', circleColor(mode))
  map.setPaintProperty(LAYER.dots, 'circle-stroke-color', circleStrokeColor(mode))
}

export function applyLinkMode(map: Map, mode: LinkMode) {
  const paint = linkPaint(mode)
  map.setPaintProperty(LAYER.links, 'line-color', paint['line-color'])
  map.setPaintProperty(LAYER.links, 'line-width', paint['line-width'])
}
