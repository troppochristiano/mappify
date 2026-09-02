import type {
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
  LayerSpecification,
  Map,
  StyleSpecification,
} from 'maplibre-gl'
import { rampAt } from './ramp'
import type { DotMode } from './ramp'

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
  detail: 'detail',
  coast: 'coast',
  links: 'links',
  nestLinks: 'nest-links',
  linkEnds: 'link-ends',
  dots: 'dots',
  friendDots: 'friend-dots',
  focus: 'focus',
} as const

export const LAYER = {
  space: 'space',
  earth: 'earth',
  detail: 'detail',
  coast: 'coast',
  countryFill: 'country-fill',
  countryLine: 'country-line',
  nestLinks: 'nest-links',
  links: 'links',
  linksActive: 'links-active',
  linksHit: 'links-hit',
  linkEnds: 'link-ends',
  friendDots: 'friend-dots',
  friendLabels: 'friend-labels',
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

/**
 * The country under the cursor.
 *
 * White rather than the accent green, which the dots already own: pointing at
 * Italy should outline Italy, not add another green thing competing with the
 * places inside it. It is the same white a selected dot takes, so "white means
 * the one you mean" holds across the map.
 */
const COUNTRY_WASH = '#ffffff'
const COUNTRY_WASH_ALPHA = 0.1
const COUNTRY_EDGE = 'rgba(255,255,255,.85)'
const COUNTRY_EDGE_ALPHA = 0.9

/**
 * A filter matching no country, which is what both highlight layers hold until
 * something is hovered.
 *
 * An iso that cannot exist rather than a literal false: the shape of the
 * expression then never changes, only the string inside it, so every setFilter
 * is swapping like for like.
 */
export const HIGHLIGHT_NONE: ExpressionSpecification = ['==', ['get', 'iso'], '--']

/** The same filter, aimed at one country. */
export const countryFilter = (iso: string | null): ExpressionSpecification =>
  iso ? ['==', ['get', 'iso'], iso] : HIGHLIGHT_NONE

/** The colour a string takes when it belongs to the place you have selected. */
const LINK_ACTIVE = 'rgba(30,215,96,.75)'

/** Uniform dot size in colour mode, where magnitude has moved to the fill. */
const UNIFORM_R = 4.5

/**
 * The default colour of an imported library, and how far its rings sit outside
 * your own dots.
 *
 * Amber because it has to survive being next to the accent green at world view
 * and still read as a different dataset rather than a different *state* of the
 * same one — white is already "the dot you mean" and the ramp already owns
 * green through gold.
 */
export const FRIEND_COLOUR = '#f0a726'

/**
 * The hues an imported library can be given, and the ones they are given.
 *
 * A short list rather than a picker. The only real requirement is "not the
 * accent green and not white", since those already mean *your library* and *the
 * one you mean* — and five hues spread far enough apart to tell two libraries
 * apart at a glance beats a wheel that lets you choose a green three shades off
 * the one underneath it.
 *
 * Here rather than in the panel that draws the swatches, because the default a
 * library takes is a fact about the overlay: the route picks one from this list
 * per library so that two of them differ before anybody chooses anything.
 */
export const FRIEND_COLOURS = ['#f0a726', '#e0508a', '#8b7cf0', '#33c4d8', '#e8543f']

const state = (key: string): ExpressionSpecification => [
  'boolean',
  ['feature-state', key],
  false,
]

/**
 * The things that mean "this is the dot you are dealing with".
 *
 * `linked` is that same statement made from the other end: the cursor is on an
 * arc, and these are the two places it joins. A collaboration is a relationship
 * between dots, so lighting the thread has to light its ends — otherwise the
 * lit line still leaves you hunting for what it connects.
 */
const focused: ExpressionSpecification = [
  'any',
  state('hover'),
  state('selected'),
  state('linked'),
]

/**
 * Set on exactly the dots whose names the focus layer is drawing, and on no
 * others — so a name gives up its own label only when a forced copy is about to
 * take its place. `hover` is not the same question: most hovered dots keep their
 * own label and are only brightened.
 */
const forced: ExpressionSpecification = state('forced')

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

/**
 * The radius at one zoom stop, for one set of dots.
 *
 * Extracted because the friend ring is defined relative to your dot, and two
 * copies of this arithmetic would be two things to keep in step. `prop` is which
 * feature property carries the magnitude: `size` is the feature's own, `mine`
 * is your dot's at the same place, and `base` is whatever a ring is stacking
 * outside — your dot, or another library's.
 */
const grow = (
  mode: DotMode,
  k: number,
  factor: number,
  prop: 'size' | 'mine' | 'base',
  /** Flat pixels added after the curve — see FRIEND_GAP. */
  gap = 0
): ExpressionSpecification =>
  mode === 'colour'
    ? ['literal', UNIFORM_R * Math.min(1.6, k) * factor + gap]
    : ['+', 2 * factor + gap, ['*', ['get', prop], 16 * k * factor]]

/** The four zoom stops every radius curve here is drawn on. */
const atZoom = (
  stop: (k: number) => ExpressionSpecification
): DataDrivenPropertyValueSpecification<number> =>
  [
    'interpolate',
    ['linear'],
    ['zoom'],
    FILL_Z, stop(1.0),
    FILL_Z + 1, stop(1.25),
    FILL_Z + 2.2, stop(1.9),
    22, stop(1.9),
  ] as DataDrivenPropertyValueSpecification<number>

export function circleRadius(
  mode: DotMode,
  /** Scales the whole curve — the friend ring sits outside your dot. */
  factor = 1
): DataDrivenPropertyValueSpecification<number> {
  return atZoom((k) => grow(mode, k, factor, 'size'))
}

/**
 * The clearance a friend's ring keeps outside your dot at a shared place.
 *
 * Flat pixels rather than a multiple, because a multiple scales the gap with the
 * dot and the dots are 2.6px across for a one-track place: 1.45× left less than
 * half a pixel of air, and none at all once the dot's own stroke widens to 1.6
 * on hover. Three is that widest stroke plus enough to read as a gap.
 */
const FRIEND_GAP = 3

/**
 * An imported library's mark: a dot exactly like one of yours, or a ring.
 *
 * A place only they have is a real place and now draws as one — same curve, same
 * factor, same shared `scaleMax`, so their forty-track city is precisely the size
 * of your forty-track city and only the hue says whose it is. That is the whole
 * of the "behave like my dots" requirement; the factor used to be 1.6.
 *
 * A ring stacks outside whatever is at the centre — your dot where you have the
 * place, the first library's where you do not — by `base`, plus one gap per
 * position outward.
 *
 * The rings are **ordinal, not magnitude**. That is a real loss and a forced one:
 * with two libraries at one city there is nothing to stop ring 1's honest radius
 * falling inside ring 0's, and rings that cross are a stacking that lies about
 * its own order. So at a shared place the ring says only *whose*, and how much
 * moves to the panel. At a place only they have, the dot still carries it.
 *
 * The arithmetic has to be built into each stop rather than wrapped around the
 * finished curve. `['+', circleRadius(mode), FRIEND_GAP]` is the obvious way and
 * an invalid style: a `zoom` expression may only be the input of a top-level
 * `interpolate`, so it cannot sit inside arithmetic.
 */
export function friendRadius(mode: DotMode): DataDrivenPropertyValueSpecification<number> {
  return atZoom((k) => {
    const asDot = grow(mode, k, 1, 'size')
    // One gap per ring outward. `ring` is -1 on a dot, so this branch is only
    // ever reached with 0 or more.
    const asRing: ExpressionSpecification = [
      '+',
      grow(mode, k, 1, 'base'),
      ['*', FRIEND_GAP, ['+', ['number', ['get', 'ring'], 0], 1]],
    ]
    return [
      'case',
      ['==', ['get', 'kind'], 'ring'],
      asRing,
      asDot,
    ] as ExpressionSpecification
  })
}

/**
 * A selected dot is white, a dimmed one recedes, and otherwise magnitude is
 * either in the fill (colour mode) or in the radius (size mode). Order matters:
 * selection wins over everything, dimming loses to it.
 *
 * `linked` is the one thing besides selection that beats the dimming, and it has
 * to: while an arc is open every other dot is dimmed, and that is exactly when
 * you are running the cursor over the quiet mass asking which thread goes where.
 * A hovered arc whose ends stayed grey would answer half the question. A dot's
 * *own* hover still loses to the dimming — pointing at a dot outside the
 * spotlight is not a claim about the arc you are reading.
 */
export function circleColor(mode: DotMode): DataDrivenPropertyValueSpecification<string> {
  const normal = mode === 'colour' ? rampStops(0.85) : DOT_GREEN
  const hot = mode === 'colour' ? rampStops(1) : DOT_GREEN_HOT
  return [
    'case',
    state('selected'), SELECTED,
    state('linked'), hot,
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
    state('linked'), normal,
    ['get', 'dim'], DIM_STROKE,
    normal,
  ] as DataDrivenPropertyValueSpecification<string>
}

const STROKE_WIDTH: DataDrivenPropertyValueSpecification<number> = [
  'case',
  ['any', state('selected'), state('hover'), state('linked')], 1.6,
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
/**
 * What an arc looks like when the cursor is on it, or when it is the one being
 * read about.
 *
 * Bright enough to pick out of the mass, because that is the whole job: a
 * collaboration arc at rest is a whisper of nine percent alpha, and the thing a
 * hover has to answer is "which of these dozen crossing threads am I about to
 * click". Kept as one colour rather than a ramp — at that point the arc's
 * magnitude is being read off the panel, not off the line.
 */
const LINK_HOT = 'rgba(190,225,255,.95)'

/**
 * The mass, while one arc is being read.
 *
 * A third of the resting floor, which is already only nine percent alpha — at
 * this point the other six hundred arcs are texture rather than lines, which is
 * the intent: the collaboration you clicked should be the only lit thing on the
 * planet. They stay askable, though. The hit layer is untouched and `hot` still
 * wins, so running the cursor across the quiet mass lights whatever is under it
 * and clicking moves the selection. The dimming is a state you can see out of.
 */
const LINK_QUIET = 'rgba(125,180,235,.035)'
const LINK_QUIET_NEST = 'rgba(160,210,255,.06)'

/**
 * Containment, drawn as background.
 *
 * A borough is inside its city, and that is the whole statement — no magnitude
 * to encode. It used to be painted at .72 and width 1.3, which was right while
 * it had the map to itself: the arcs are short, joining dots that already
 * overlap, so at that length they need weight to register at all. Sharing the
 * map with the collaboration arcs changed the question. A one-track collab is
 * .09; anything approaching .72 sitting on top of that is not a second layer of
 * information, it is a lid. So it sits low enough to read as the shape of the
 * data rather than as a finding about it.
 *
 * Nothing hot here: nesting is not hit-tested (see `linkAt` in Globe.tsx), so
 * no arc in this source is ever hovered or selected and a `case` on state
 * would be an expression evaluated per feature to always take the same branch.
 *
 * @param quiet a collaboration is being read, so even the background steps back.
 */
export function nestPaint(quiet = false) {
  return {
    'line-color': quiet ? LINK_QUIET_NEST : 'rgba(160,210,255,.34)',
    'line-width': quiet ? 0.6 : 0.9,
  }
}

/**
 * @param quiet one arc is selected, so the rest are only context. No expression
 * can ask "is any other feature selected", so it has to arrive as a parameter —
 * and it has to arrive *here*, because applyCollabPaint reassigns these two
 * properties wholesale and anything bolted on beside them is lost the next time
 * an arc is selected.
 */
function linkPaint(quiet = false) {

  // Both states go through the same `case`, so a repaint cannot drop them —
  // applyCollabPaint reassigns these two properties wholesale, and a hover rule
  // living outside this function would survive exactly until the first one.
  const hot: ExpressionSpecification = ['any', state('hover'), state('selected')]

  return {
    'line-color': [
      'case',
      hot, LINK_HOT,
      quiet
        ? LINK_QUIET
        : [
            'interpolate', ['linear'], ['get', 'tracks'],
            1, 'rgba(125,180,235,.09)',
            3, 'rgba(135,190,240,.20)',
            10, 'rgba(150,205,255,.42)',
          ],
    ] as DataDrivenPropertyValueSpecification<string>,
    'line-width': [
      'case',
      // A flat 2.2 rather than a scaled version of the ramp: the faintest arcs
      // are half a pixel, and 1.5× of nothing is still nothing to aim at.
      hot, 2.2,
      // Flat when quiet, for the same reason the hot width is flat: a fraction
      // of half a pixel is not a thinner line, it is no line.
      quiet
        ? 0.4
        : [
            'interpolate', ['linear'], ['get', 'tracks'],
            1, 0.5,
            3, 0.7,
            10, 1.1,
          ],
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

/**
 * Where the photographed world takes over from the painted one.
 *
 * Blue Marble is one image of the whole planet: it is genuinely resolved to
 * about z5 and is invented past that, so on the way into a city it turns to
 * mud. Satellite tiles carry the same ground at street scale, which is the
 * whole of what "zoom in and see the city from above" needs — but they are a
 * network round trip per tile, so they are not asked for until the base has
 * actually run out.
 *
 * The handover is a crossfade rather than a switch, because a hard swap between
 * two differently-coloured pictures of the same coastline reads as a glitch.
 * Both layers stay drawn: if the satellite tiles never arrive — offline, or a
 * provider that is down — the missing ones simply are not painted and Blue
 * Marble shows through, which is the old behaviour rather than a black hole.
 */
const DETAIL_IN = 4.5
const DETAIL_FULL = 6.5

/** What the detail imagery is asked for, and how deep it goes. */
export type Detail = {
  tiles: string
  maxzoom: number
  attribution?: string
}

export function buildStyle(
  glyphs: string,
  tiles: string,
  maxzoom: number,
  detail?: Detail
): StyleSpecification {
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
      ...(detail
        ? {
            [SOURCE.detail]: {
              type: 'raster' as const,
              tiles: [detail.tiles],
              // Web map services serve 256px tiles; declaring 512 would stretch
              // every one of them to twice its size and undo the detail this
              // layer exists for.
              tileSize: 256,
              maxzoom: detail.maxzoom,
              attribution: detail.attribution,
              volatile: false,
            },
          }
        : {}),
      [SOURCE.coast]: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      [SOURCE.links]: {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        // An arc's natural key is the pair of places it joins, which is a
        // string — and a string cannot be a top-level feature id here, for the
        // reason set out on the dots source below: GeoJSON sources are encoded
        // as vector tiles, where ids are numeric, so a string id silently
        // becomes 0 and every arc ends up sharing one feature-state. `id` is
        // composed in linksToGeoJSON as `${a}~${b}` and promoted here.
        promoteId: 'id',
      },
      // Its own source rather than a filter on the one above: the two hold
      // different relations, are painted differently, and only one of them is
      // ever asked what is under the cursor. promoteId for the same reason as
      // the links source — a string id would silently collapse to 0 — even
      // though nothing sets feature-state on these today.
      [SOURCE.nestLinks]: {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        promoteId: 'id',
      },
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
      // No promoteId, and for a simpler reason than the dots: this source holds
      // no feature-state at all. It is two points at most, and they are drawn or
      // they are not.
      [SOURCE.linkEnds]: {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      },
      // One source for every imported library, keyed by a namespaced id.
      //
      // This used to carry no promoteId at all, because a single source holding
      // several libraries would key feature-state on qid — and a shared city has
      // the same qid in all of them, so hovering one mark would light every
      // library's. `fid` is `${libraryId}:${qid}`, which is exactly the
      // namespacing that note asked for, so hover and selection can live here.
      [SOURCE.friendDots]: {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        promoteId: 'fid',
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
      ...(detail
        ? [
            {
              id: LAYER.detail,
              type: 'raster',
              source: SOURCE.detail,
              // No tiles requested at all until the fade is about to start, so
              // spinning the whole planet around costs nothing.
              minzoom: DETAIL_IN,
              paint: {
                'raster-opacity': [
                  'interpolate',
                  ['linear'],
                  ['zoom'],
                  DETAIL_IN,
                  0,
                  DETAIL_FULL,
                  1,
                ],
                // The same holding-back the base gets, for the same reason: at
                // world view a mid-green dot has to survive being over snow.
                // It lifts on the way in, where there are few dots on screen and
                // the picture underneath is the point.
                'raster-brightness-max': ['interpolate', ['linear'], ['zoom'], 5, 0.78, 8, 1],
                'raster-saturation': ['interpolate', ['linear'], ['zoom'], 5, -0.15, 8, 0],
                'raster-fade-duration': 180,
              },
            } as LayerSpecification,
          ]
        : []),
      // The country under the cursor, on the same source as the outline above:
      // a wash to say which landmass, and a border bright enough to read at
      // world view. Both start filtered to nothing — HIGHLIGHT_NONE — and the
      // component swaps in an iso match on hover.
      //
      // Below the coast layer rather than above it, so the faint global outline
      // still draws over the wash and the highlighted country does not lose its
      // internal coastline detail.
      {
        id: LAYER.countryFill,
        type: 'fill',
        source: SOURCE.coast,
        filter: HIGHLIGHT_NONE,
        paint: {
          'fill-color': COUNTRY_WASH,
          'fill-opacity': COUNTRY_WASH_ALPHA,
        },
      },
      {
        id: LAYER.countryLine,
        type: 'line',
        source: SOURCE.coast,
        filter: HIGHLIGHT_NONE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': COUNTRY_EDGE,
          // Thicker as you go in, but never hairline at world view, which is
          // exactly where the whole country has to be readable at a glance.
          'line-width': ['interpolate', ['linear'], ['zoom'], 0, 1.2, 4, 1.8, 8, 2.4],
          'line-opacity': COUNTRY_EDGE_ALPHA,
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
          // Without detail imagery this is the only thing left to navigate by
          // past the pyramid, so it fades in and stays. With it, the coastline
          // is only cover for the crossfade: these outlines are 110m-generalised
          // and by city scale they cut visibly across the real shoreline, so
          // they leave again as soon as the photograph is carrying orientation
          // on its own.
          'line-opacity': detail
            ? ['interpolate', ['linear'], ['zoom'], 5, 0, 5.8, 0.45, 6.8, 0]
            : ['interpolate', ['linear'], ['zoom'], 5.5, 0, 8.5, 0.5],

        },
      },
      // Beneath the collaboration arcs, and listed first because that is what
      // "beneath" means here. Structure goes under findings.
      {
        id: LAYER.nestLinks,
        type: 'line',
        source: SOURCE.nestLinks,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          ...nestPaint(),
          'line-color-transition': { duration: 220 },
          'line-width-transition': { duration: 220 },
        },
      },
      {
        id: LAYER.links,
        type: 'line',
        source: SOURCE.links,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        // On the literal rather than in linkPaint: applyCollabPaint never
        // reassigns transitions, so restating them on every repaint would be
        // work with no effect.
        paint: {
          ...linkPaint(),
          'line-color-transition': { duration: 220 },
          'line-width-transition': { duration: 220 },
        },
      },
      {
        id: LAYER.linksHit,
        type: 'line',
        source: SOURCE.links,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        /**
         * Nothing to look at — this layer exists to be *asked* about.
         *
         * The arcs it shadows are between half a pixel and one wide, and a
         * one-pixel target is not a target: on a globe covered in crossing
         * threads you would be hunting for the cursor rather than for the
         * collaboration. So the pointer aims at a fat invisible copy instead,
         * and `queryRenderedFeatures` reports the arc underneath it.
         *
         * Invisible via opacity rather than `visibility: none`, which is the
         * whole trick: a layer that is not visible is not rendered, and a layer
         * that is not rendered cannot be queried. Zero-opacity still counts as
         * drawn, so the geometry stays askable while nothing reaches the screen.
         */
        paint: { 'line-opacity': 0, 'line-width': 14 },
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
      // With the link layers, because it belongs to the arc rather than to the
      // library — and below both dot layers, so a real dot always outranks a
      // placeholder if a filter change ever restores one at the same spot.
      {
        id: LAYER.linkEnds,
        type: 'circle',
        source: SOURCE.linkEnds,
        paint: linkEndPaint(),
      },
      // Below the dots, so your own library always holds the foreground and a
      // shared city reads as your dot inside their ring rather than the other
      // way round. Empty until a friend is picked, so it costs nothing.
      {
        id: LAYER.friendDots,
        type: 'circle',
        source: SOURCE.friendDots,
        paint: friendPaint(),
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
      // Their names, below yours on purpose.
      //
      // Placement runs top layer first, so whichever label layer sits higher
      // gets first refusal on every slot. Yours therefore go down first and win
      // every collision; theirs fill what is left. Within this layer the same
      // sort key arbitrates between libraries by track count, which is why they
      // share one layer rather than having one each — a layer apiece would rank
      // them by the order they were added, forever.
      //
      // Rings are excluded. A ring is not a place; it says who else has the one
      // underneath, and that place already has a name from whatever drew the dot.
      {
        id: LAYER.friendLabels,
        type: 'symbol',
        source: SOURCE.friendDots,
        filter: ['all', ['!', ['get', 'dim']], ['==', ['get', 'kind'], 'solo']],
        layout: {
          ...LABEL_PLACEMENT,
          'text-field': ['get', 'name'],
          'symbol-sort-key': ['-', 0, ['get', 'tracks']],
        },
        paint: {
          ...LABEL_PAINT,
          // The same white as your own names, not the library's hue. Colour is
          // the dot's job and the dot is right there; a tinted name only made
          // the one thing that has to stay readable over snow and ocean harder
          // to read, and said nothing the mark beneath it had not already said.
          'text-color': ['case', state('hover'), '#fff', LABEL_PAINT['text-color']],
          'text-halo-width': ['case', state('hover'), 1.6, LABEL_PAINT['text-halo-width']],
          // Exactly as LAYER.labels does it, and for the same reason: when the
          // focus layer draws a forced copy of a name, the copy placed here has
          // to go transparent or the place is labelled twice, a few pixels
          // apart. Hidden rather than filtered, so the slot stays reserved and
          // the names around it do not shuffle to fill a gap.
          'text-opacity': ['case', forced, 0, 1],
          'text-opacity-transition': { duration: 0 },
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
          // Pointing at a dot whose name is already on screen brightens that
          // name where it stands. It does not get a second, forced copy — that
          // is what the doubling was: the collision grid's placement and the
          // focus layer's override, a few pixels apart, both drawn.
          //
          // Weight cannot join in. text-font is a layout property, and layout
          // properties cannot read feature state at all, which is also why the
          // forced label needs a layer of its own rather than a case expression
          // here. Colour and halo are the whole of the hover treatment.
          'text-color': ['case', focused, '#fff', LABEL_PAINT['text-color']],
          'text-halo-width': ['case', focused, 1.6, LABEL_PAINT['text-halo-width']],
          // Stand down only for a name the focus layer is actually drawing —
          // one whose own label was collided away, or dimmed out of this layer
          // entirely — never merely because it is hovered.
          //
          // Hidden rather than filtered out. A filter would drop the feature
          // from the layer entirely, freeing the slot it was holding, and every
          // name around it would shuffle to fill the gap — so pointing at a dot
          // would rearrange the map. Going transparent keeps the slot reserved,
          // which is what makes the swap invisible.
          'text-opacity': ['case', forced, 0, 1],
          // Instantly, or the fading-out original and the forced copy overlap
          // for the length of the default transition — the doubling again, just
          // brief enough to read as a flicker.
          'text-opacity-transition': { duration: 0 },
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

/**
 * A friend's places: rings, not discs.
 *
 * The two libraries overlap on exactly the cities the comparison is about, so
 * co-location is the normal case rather than an edge case — and two filled
 * circles at one coordinate means one of them is simply invisible. A hollow ring
 * a little larger than your dot puts the shared city on screen as your green
 * centre inside their halo, which is the comparison drawn rather than described.
 *
 * No ramp here on purpose. Yours already encodes magnitude in colour (in colour
 * mode) and in radius; a second ramp would give the eye two green-to-gold scales
 * to tell apart. One flat hue, magnitude in radius only, so hue means *whose*
 * and size means *how much*.
 */
/**
 * An end of the selected arc that your library has no dot for.
 *
 * These places are real. The globe counts primary credits — a dot means "music
 * by someone from here" — while an arc counts every credit, because a track with
 * only a lead artist connects nothing. So a place whose one artist appears
 * solely as a featured credit is genuinely in the library and absent from the
 * map, and 194 of the 696 collaboration arcs have at least one such end.
 *
 * Rather than let the arc terminate in nothing, the missing end is drawn — but
 * only while that arc is selected, so the ordinary meaning of a dot is left
 * intact. In the arc's own hot colour rather than the dot green, because this is
 * part of the line and not part of your library; hollow, so it reads as a
 * place-shaped absence. Distinct from the friend ring, which is amber and always
 * drawn *around* a dot rather than alone.
 *
 * A fixed radius, deliberately: the marker has no magnitude to encode, which is
 * precisely the fact it exists to state.
 */
export function linkEndPaint() {
  return {
    'circle-radius': [
      'interpolate', ['linear'], ['zoom'],
      FILL_Z, 4.5,
      FILL_Z + 2.2, 6.5,
    ] as DataDrivenPropertyValueSpecification<number>,
    'circle-color': 'rgba(0,0,0,0)',
    'circle-stroke-color': LINK_HOT,
    'circle-stroke-width': 1.3,
    'circle-stroke-opacity': 0.9,
  }
}

/**
 * Every imported library, from one layer.
 *
 * The colour is data, not paint: `['get','colour']` means a single layer serves
 * any number of libraries, and a new one costs a feature rather than a layer.
 * Repainting for a newly picked hue then means re-emitting the collection — a
 * few thousand features, which the overlay already does on every prop change.
 *
 * A dot is filled and a ring is not. Hollow used to read as absence, and for a
 * place only they have it still would — those are filled. A ring is not a place
 * though; it is a mark saying *who else* has the one underneath it, and there is
 * something at its centre already.
 */
export function friendPaint(mode: DotMode = 'size') {
  return {
    'circle-radius': friendRadius(mode),
    'circle-color': [
      'case',
      state('selected'), SELECTED,
      ['get', 'dim'], DIM_FILL,
      state('hover'), ['get', 'hot'],
      // Rings show the ground through them; only a dot is filled.
      ['==', ['get', 'kind'], 'ring'], 'rgba(0,0,0,0)',
      ['get', 'colour'],
    ] as DataDrivenPropertyValueSpecification<string>,
    // Matches the 0.85 the own-dot ramp uses, so neither library looks heavier
    // than the other on a globe showing both.
    'circle-opacity': 0.85,
    'circle-stroke-color': [
      'case',
      state('selected'), '#fff',
      ['get', 'dim'], DIM_STROKE,
      state('hover'), ['get', 'hot'],
      ['get', 'colour'],
    ] as DataDrivenPropertyValueSpecification<string>,
    'circle-stroke-width': [
      'case',
      ['any', state('selected'), state('hover')], 1.6,
      1.4,
    ] as DataDrivenPropertyValueSpecification<number>,
    'circle-stroke-opacity': 0.85,
  }
}

/** Repaint the dots for a different encoding. No source change, no re-upload. */
export function applyDotMode(map: Map, mode: DotMode) {
  map.setPaintProperty(LAYER.dots, 'circle-radius', circleRadius(mode))
  map.setPaintProperty(LAYER.dots, 'circle-color', circleColor(mode))
  map.setPaintProperty(LAYER.dots, 'circle-stroke-color', circleStrokeColor(mode))
  // The rings too, or they keep the size curve while your dots go uniform and
  // the whole overlay disappears under them. Their own guard, not the one above:
  // the friend layer is the one that can be missing.
  if (map.getLayer(LAYER.friendDots)) {
    map.setPaintProperty(LAYER.friendDots, 'circle-radius', friendRadius(mode))
  }
}

/**
 * Quieten, or un-quieten, both relations at once.
 *
 * One call rather than two because they are one decision: an arc is being read,
 * so everything that is not that arc steps back — the other collaborations and
 * the containment underneath them alike.
 */
export function applyLinkQuiet(map: Map, quiet = false) {
  const collab = linkPaint(quiet)
  map.setPaintProperty(LAYER.links, 'line-color', collab['line-color'])
  map.setPaintProperty(LAYER.links, 'line-width', collab['line-width'])
  const nest = nestPaint(quiet)
  map.setPaintProperty(LAYER.nestLinks, 'line-color', nest['line-color'])
  map.setPaintProperty(LAYER.nestLinks, 'line-width', nest['line-width'])
}
