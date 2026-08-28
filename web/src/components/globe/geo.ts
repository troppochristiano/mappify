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
  scaleMax?: number
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
      },
    })),
  }
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
