import { feature } from 'topojson-client'
import type { Topology } from 'topojson-specification'
import worldTopo from 'world-atlas/countries-110m.json'
import { ISO_NUMERIC_TO_ALPHA2 } from './iso'
import type { MapPoint, PlaceLink } from '../../lib/api'

/**
 * Turning mappify's data into the GeoJSON the map layers read.
 *
 * Nothing here knows about MapLibre. These are plain transforms, kept apart
 * from the component so the shapes can be reasoned about — and rebuilt — on
 * their own.
 */

export type FC<G, P> = { type: 'FeatureCollection'; features: Feat<G, P>[] }
type Feat<G, P> = { type: 'Feature'; id?: string | number; geometry: G; properties: P }
type Point = { type: 'Point'; coordinates: [number, number] }
type Line = { type: 'LineString'; coordinates: [number, number][] }

export type CountryProps = {
  /**
   * Alpha-2, or null for the three territories the topology gives no numeric
   * code. Null never matches a highlight, which is the right outcome: mappify
   * has no alpha-2 for them either.
   */
  iso: string | null
}

/**
 * Country outlines, converted once.
 *
 * The canvas globe walked this topology every frame; here it is handed to the
 * map as a source and never touched again. It is drawn as a thin overlay that
 * only appears once the imagery has run out of detail — see the coast layer —
 * and, filtered to one country, as the hover highlight.
 */
export const coastlines = (() => {
  const topo = worldTopo as unknown as Topology
  const fc = feature(topo, topo.objects.countries) as unknown as FC<
    { type: string; coordinates: unknown },
    CountryProps
  >
  // The same features carry the outline *and* the highlight: one copy of the
  // geometry in the style, filtered two different ways, rather than a second
  // source holding the identical ~100KB.
  for (const f of fc.features) {
    f.properties = { iso: ISO_NUMERIC_TO_ALPHA2[String(f.id).padStart(3, '0')] ?? null }
  }
  return fc
})()

export type DotProps = {
  qid: string
  name: string
  tracks: number
  artists: number
  country_iso: string | null
  /**
   * Track count on a 0..1 log scale, precomputed.
   *
   * Counts run 1 to ~600 and are heavily skewed, so the colour ramp is
   * logarithmic. A style expression *could* do the log, but it would redo it
   * for every dot on every style evaluation, and the maximum it is relative to
   * is a property of the whole set rather than of any one feature — so it is
   * worked out here, once, where the set is in hand.
   */
  weight: number
  /**
   * Track count as a 0..1 *area* scale — the square root, so one artist with
   * 150 tracks cannot swamp the map the way a linear radius would.
   */
  size: number
  /**
   * Quietened, because a search is filtering or the place menu is spotlighting
   * a country and this place is outside it.
   *
   * Baked into the data rather than held as feature-state, because a label on a
   * dimmed dot must not merely be transparent — it has to be *absent*, or it
   * goes on reserving space in the collision grid and pushes out the names that
   * are supposed to be visible. Only `filter` can do that, and filters cannot
   * read feature-state.
   */
  dim: boolean
  /**
   * How big *your* dot is at this place, on the same 0..1 area scale as `size`.
   *
   * Only ever non-zero on the friend overlay, and only for a place you both
   * have — which is what makes it the test for "shared": every real place has at
   * least one track, so a zero here means you do not have this one.
   *
   * It exists so a friend's ring can be held outside your dot rather than
   * disappearing under it. Their ring is sized by their own track count, and for
   * a city where they have two tracks and you have two hundred that ring is
   * drawn well inside your dot — truthful and invisible, which is the one
   * combination no encoding is allowed to be.
   */
  mine: number
}

/**
 * Places, carrying `qid` as a property.
 *
 * Not as a top-level feature `id`, which is where it belongs and where it does
 * not survive — the source promotes the property to the id instead. See the
 * note on `promoteId` in the layer definitions.
 */
export function dotsToGeoJSON(
  points: MapPoint[],
  /** Null means no filter: everything is lit. */
  lit: Set<string> | null,
  /** Null means no spotlight. */
  spot: Set<string> | null,
  /**
   * The track count that counts as full size, if it is not this set's own
   * maximum.
   *
   * Both encodings below are *relative*, so the scale is decided by whatever
   * array is passed in. That is right for one library on its own and wrong the
   * moment two are drawn together: called separately for a friend's places,
   * their biggest city renders exactly as large as your biggest city whether
   * they have thirty tracks or three thousand. The overlay exists to make that
   * comparison, so it has to hand both calls the maximum across the union.
   *
   * Defaults to the in-array maximum, which is what every existing caller wants
   * and what this always did.
   */
  scaleMax?: number,
  /**
   * Your own places, for the overlay to measure itself against.
   *
   * Passed on the friend call and on no other — see `mine` in DotProps. Keyed by
   * qid, which both libraries share for the same city; that is the whole premise
   * of the overlay.
   */
  mine?: ReadonlyMap<string, MapPoint>
): FC<Point, DotProps> {
  // Floored at 1 for the same reason the reduce seeds at 1: an empty library, or
  // a union maximum of zero, would otherwise divide every size by zero.
  const max = Math.max(1, scaleMax ?? points.reduce((m, p) => (p.tracks > m ? p.tracks : m), 1))
  const logMax = Math.log(1 + max)
  return {
    type: 'FeatureCollection',
    features: points.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: {
        qid: p.qid,
        name: p.name,
        tracks: p.tracks,
        artists: p.artists,
        country_iso: p.country_iso,
        weight: Math.log(1 + p.tracks) / logMax,
        size: Math.sqrt(p.tracks / max),
        dim: (lit != null && !lit.has(p.qid)) || (spot != null && !spot.has(p.qid)),
        // Against the same max as `size` above, so the two are directly
        // comparable. Always emitted, never omitted: a missing property makes
        // the style's assertions throw and drops the feature entirely.
        mine: Math.sqrt((mine?.get(p.qid)?.tracks ?? 0) / max),
      },
    })),
  }
}

/** One imported library, as the overlay needs it. */
export type FriendLib = { id: number; colour: string; points: MapPoint[] }

export type FriendProps = {
  /**
   * The feature id, namespaced `${libId}:${qid}`.
   *
   * Namespaced because one source now holds every library, and several of them
   * hold the same qid for the same city — that is the point of an overlay. A
   * feature-state keyed on qid alone would light three libraries' marks as one.
   * This is also what makes `promoteId` safe here at last.
   */
  fid: string
  qid: string
  name: string
  tracks: number
  /** Their track count on the shared 0..1 area scale — see DotProps.size. */
  size: number
  /**
   * What this ring stacks outside, on the same scale.
   *
   * Your dot where you have the place, and the first library's dot where you do
   * not — so one radius expression serves both without being told which case it
   * is in. Zero on a filled dot, which has nothing to stack outside.
   */
  base: number
  /** Ring index, outward from the dot at the centre. -1 on a filled dot. */
  ring: number
  /** A place drawn as a dot, or a ring around somebody else's. */
  kind: 'solo' | 'ring'
  colour: string
  /** The hover tint. Precomputed: the expression language has no lighten. */
  hot: string
  dim: boolean
}

/** A little brighter, for hover. Hex in, hex out; anything else passes through. */
function lighten(colour: string, by = 0.22): string {
  const m = /^#([0-9a-f]{6})$/i.exec(colour)
  if (!m) return colour
  const n = parseInt(m[1], 16)
  const mix = (c: number) => Math.round(c + (255 - c) * by)
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((c) => mix(c).toString(16).padStart(2, '0'))
    .join('')}`
}

/**
 * Every visible imported library, as one collection.
 *
 * One source rather than one per library, because circle paint is data-driven:
 * `['get','colour']` serves all of them from a single layer. That is not only
 * cheaper — it is the only way the *labels* can be fair. Label priority between
 * two symbol layers is decided by which layer is on top, so a layer per library
 * would give the first one permanent precedence over the second regardless of
 * how much music is there. In one layer, `symbol-sort-key` arbitrates honestly.
 *
 * Three cases, and each place lands in exactly one of them:
 *
 *   you have it        one ring per library, stacked outward around your dot
 *   one library only   a filled dot, sized exactly like one of yours
 *   several, not you   the first library's filled dot, the rest as rings
 *
 * The partition is structural rather than checked: a ring always has a `base`
 * to sit outside, a dot never does, and the two are told apart by `kind`.
 */
export function friendsToGeoJSON(
  /** Your own places, to know which cities are shared. Keyed by qid. */
  mine: ReadonlyMap<string, MapPoint>,
  libs: FriendLib[],
  /** Null means no filter: everything is lit. */
  lit: Set<string> | null,
  /** Null means no spotlight. */
  spot: Set<string> | null,
  /** The count that counts as full size, across your library and all of theirs. */
  scaleMax?: number
): FC<Point, FriendProps> {
  const max = Math.max(
    1,
    scaleMax ??
      libs.reduce((m, l) => l.points.reduce((n, p) => (p.tracks > n ? p.tracks : n), m), 1)
  )
  const area = (tracks: number) => Math.sqrt(tracks / max)

  // Grouped by place, in the order the libraries were given, so which one gets
  // the dot at a place none of yours covers is stable rather than incidental.
  const at = new Map<string, { lib: FriendLib; point: MapPoint }[]>()
  for (const lib of libs) {
    for (const point of lib.points) {
      const list = at.get(point.qid)
      if (list) list.push({ lib, point })
      else at.set(point.qid, [{ lib, point }])
    }
  }

  const features: FC<Point, FriendProps>['features'] = []
  for (const [qid, here] of at) {
    const yours = mine.get(qid)
    const dim = (lit != null && !lit.has(qid)) || (spot != null && !spot.has(qid))
    // Where you have the place, every library is a ring around your dot. Where
    // you do not, the first draws the dot and the others ring it.
    const dotIndex = yours ? -1 : 0
    const base = yours ? area(yours.tracks) : area(here[0].point.tracks)

    here.forEach(({ lib, point }, i) => {
      const isDot = i === dotIndex
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
        properties: {
          fid: `${lib.id}:${qid}`,
          qid,
          name: point.name,
          tracks: point.tracks,
          size: area(point.tracks),
          base: isDot ? 0 : base,
          // Rings count outward from whatever is at the centre, so the first
          // ring is 0 when it surrounds your dot and 1 when it surrounds
          // another library's.
          ring: isDot ? -1 : yours ? i : i - 1,
          kind: isDot ? 'solo' : 'ring',
          colour: lib.colour,
          hot: lighten(lib.colour),
          dim,
        },
      })
    })
  }
  return { type: 'FeatureCollection', features }
}

const RAD = Math.PI / 180

/**
 * How many segments a link is cut into.
 *
 * d3-geo gave curvature away: a two-point LineString *is* a great circle to it,
 * resampled adaptively at draw time. MapLibre draws exactly the vertices it is
 * given, so a two-point line is a straight chord — which on a globe cuts
 * visibly through the planet on anything longer than a few hundred kilometres.
 * The arc has to be built here instead. 32 is past the point where more
 * segments change the picture, and the whole set is a few thousand vertices.
 */
const ARC_SEGMENTS = 32

/**
 * A great circle between two places, as a densified line.
 *
 * Spherical linear interpolation rather than lerping lat/lon: the naive version
 * is only right for links along a meridian and bows the wrong way everywhere
 * else, worst exactly on the transatlantic hops that are most visible.
 */
function greatCircle(alon: number, alat: number, blon: number, blat: number): [number, number][] {
  const φ1 = alat * RAD
  const λ1 = alon * RAD
  const φ2 = blat * RAD
  const λ2 = blon * RAD

  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((φ2 - φ1) / 2) ** 2 +
          Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2
      )
    )
  // Coincident or near-coincident endpoints: nesting links join a borough to
  // its city and are routinely under a kilometre, where sin(d) underflows.
  if (!d || !Number.isFinite(d)) {
    return [
      [alon, alat],
      [blon, blat],
    ]
  }

  const out: [number, number][] = []
  let prevLon = alon
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    const f = i / ARC_SEGMENTS
    const a = Math.sin((1 - f) * d) / Math.sin(d)
    const b = Math.sin(f * d) / Math.sin(d)
    const x = a * Math.cos(φ1) * Math.cos(λ1) + b * Math.cos(φ2) * Math.cos(λ2)
    const y = a * Math.cos(φ1) * Math.sin(λ1) + b * Math.cos(φ2) * Math.sin(λ2)
    const z = a * Math.sin(φ1) + b * Math.sin(φ2)
    const lat = Math.atan2(z, Math.hypot(x, y)) / RAD
    let lon = Math.atan2(y, x) / RAD

    // Keep the line running continuously rather than jumping ±360 when it
    // crosses the antimeridian, or it whips back across the whole map. The
    // globe projection is happy with longitudes outside -180..180.
    while (lon - prevLon > 180) lon -= 360
    while (prevLon - lon > 180) lon += 360
    prevLon = lon

    out.push([lon, lat])
  }
  return out
}

export type LinkProps = {
  a: string
  b: string
  tracks: number
  /**
   * Where the arc's two ends actually are.
   *
   * Carried rather than read back off the geometry, because the geometry is not
   * a pair of places: `greatCircle` unwraps longitudes past ±180 to keep the
   * line continuous across the antimeridian, and a vertex at 181° is not
   * somewhere you can put a marker. The hover handler has only the queried
   * feature to go on, so the honest coordinates have to travel with it.
   */
  alon: number
  alat: number
  blon: number
  blat: number
}

export function linksToGeoJSON(links: PlaceLink[]): FC<Line, LinkProps> {
  return {
    type: 'FeatureCollection',
    features: links.map((l) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: greatCircle(l.alon, l.alat, l.blon, l.blat) },
      // Nesting links carry no track count and are all one weight, so they fall
      // through the width ramp at its floor.
      //
      // `id` is the pair itself, which is already unique — the collab query
      // yields each pair once, and a place is never its own parent. It exists so
      // an arc can carry feature-state for hover and selection, the same way a
      // dot does, and it is a *property* rather than a top-level feature id for
      // the reason spelled out on the dots source: string ids do not survive the
      // trip through the worker, so the source promotes this one instead.
      properties: {
        id: `${l.a}~${l.b}`,
        a: l.a,
        b: l.b,
        tracks: l.tracks ?? 1,
        alon: l.alon,
        alat: l.alat,
        blon: l.blon,
        blat: l.blat,
      },
    })),
  }
}
