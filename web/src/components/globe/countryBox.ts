import { geoArea, geoBounds } from 'd3-geo'
import { coastlines } from './geo'

/**
 * The box to frame when you want to be shown a country.
 *
 * Not the bounding box of everything the country owns. The United States owns
 * Alaska and Hawaii, France owns French Guiana, Norway owns Svalbard — fit all
 * of that and hovering "France" frames the Atlantic with a smudge of Europe on
 * one side. What someone means by "show me France" is the part of France that
 * looks like France.
 *
 * So: rank a country's landmasses by area, keep them until they account for
 * COVERAGE of its land, and bound what is left. That is scale-free — no
 * threshold in degrees, which would be wrong at different latitudes and wrong
 * again for small countries — and it decides every awkward case correctly
 * without naming any of them:
 *
 *   US   1 of 10 polygons at 84%   the lower 48
 *   FR   1 of 3      at 85%        the hexagon, without Guiana
 *   NO   1 of 4      at 83%        the mainland, without Svalbard
 *   CA   1 of 30     at 84%        the mainland, without the arctic islands
 *   RU   1 of 12     at 98%        one landmass, across the antimeridian
 *   NZ   2 of 2      at 100%       both islands, because both are the country
 *   JP   2 of 3      at 95%        Honshu is only 73%, so Hokkaido comes too
 *   ID   4 of 13     at 86%        an archipelago keeps being an archipelago
 *
 * 0.8 is load-bearing only between 0.6 and 0.85: Japan must exceed it to reach
 * Hokkaido, France must stop below it to shed Guiana. The middle of that gap is
 * the least arbitrary place to stand.
 *
 * Two countries sit close to the line. Great Britain alone is 95% of the UK, so
 * Northern Ireland falls outside the box by about a degree and a half of
 * longitude; mainland Greece is 93%, which drops Crete. Both are inside the
 * padding the camera adds, so neither is cropped in practice — if that ever
 * stops being true, OVERRIDE below is the honest fix, because this geometry is a
 * frozen module import and a hand-checked value cannot rot.
 */
export type Box = [[number, number], [number, number]]

const COVERAGE = 0.8

/**
 * Boxes that the rule above gets wrong, if any are ever found.
 *
 * Empty on purpose: every country checked so far comes out right, and an empty
 * table is the evidence for that rather than an omission.
 */
const OVERRIDE: Record<string, Box> = {}

type Ring = number[][]
type Poly = Ring[]

/**
 * iso → its polygons, built on first ask rather than at import.
 *
 * Roughly 180 features to walk, and a route that never frames a country should
 * not pay for it.
 */
let byIso: Map<string, Poly[]> | null = null

function polygons(iso: string): Poly[] | null {
  if (!byIso) {
    byIso = new Map()
    for (const f of coastlines.features) {
      if (!f.properties.iso) continue
      const g = f.geometry as unknown as
        | { type: 'Polygon'; coordinates: Poly }
        | { type: 'MultiPolygon'; coordinates: Poly[] }
      byIso.set(f.properties.iso, g.type === 'Polygon' ? [g.coordinates] : g.coordinates)
    }
  }
  return byIso.get(iso) ?? null
}

const keptCache = new Map<string, Poly[] | null>()
const boxCache = new Map<string, Box | null>()

/**
 * The landmasses that make up COVERAGE of a country, largest first.
 *
 * Exported because a check that the camera framed a country properly has to test
 * the land that was meant to be framed, not the box — a box says nothing about
 * whether the coastline inside it ended up on screen.
 */
export function keptPolygons(iso: string): Poly[] | null {
  const hit = keptCache.get(iso)
  if (hit !== undefined) return hit

  const all = polygons(iso)
  if (!all?.length) {
    keptCache.set(iso, null)
    return null
  }

  // geoArea is spherical and in steradians, so this is real area on the globe
  // rather than area in some projection that flatters the poles.
  const ranked = all
    .map((coordinates) => ({ coordinates, a: geoArea({ type: 'Polygon', coordinates }) }))
    .sort((x, y) => y.a - x.a)
  const total = ranked.reduce((n, p) => n + p.a, 0)

  const kept: Poly[] = []
  let acc = 0
  for (const p of ranked) {
    kept.push(p.coordinates)
    acc += p.a
    // Tested after pushing, so the largest landmass is always kept even in the
    // degenerate case where one polygon is already past the threshold.
    if (total <= 0 || acc / total >= COVERAGE) break
  }

  keptCache.set(iso, kept)
  return kept
}

/**
 * The box to frame for a country, or null for one the topology does not have.
 *
 * West may be greater than east: geoBounds is spherical, so Russia comes back as
 * 27.3..-169.9 rather than a box spanning the whole planet the other way round.
 * MapLibre reads that correctly — LngLatBounds.adjustAntiMeridian is exactly the
 * case — which is why none of this normalises longitudes by hand.
 */
export function countryBox(iso: string): Box | null {
  const hit = boxCache.get(iso)
  if (hit !== undefined) return hit

  const override = OVERRIDE[iso]
  if (override) {
    boxCache.set(iso, override)
    return override
  }

  const kept = keptPolygons(iso)
  const box = kept ? (geoBounds({ type: 'MultiPolygon', coordinates: kept }) as Box) : null
  boxCache.set(iso, box)
  return box
}
