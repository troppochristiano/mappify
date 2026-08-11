/**
 * How magnitude is encoded, and in what colours.
 *
 * Split out of the component because both the map layers and the legend in the
 * route read it: the globe turns `rampAt` into GPU interpolation stops, the
 * legend turns it into swatches, and neither restates the colours.
 */

/**
 * How a dot carries "how much music is from here".
 *
 * `size` reads instantly but the biggest dots swallow their neighbours, which is
 * worst exactly where the data is densest. `colour` keeps every dot the same
 * target size — better for clicking and for seeing how many distinct places
 * there are — at the cost of needing a legend.
 */
export type DotMode = 'size' | 'colour'

export const DOT_MODES: { id: DotMode; label: string }[] = [
  { id: 'size', label: 'size' },
  { id: 'colour', label: 'colour' },
]

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
