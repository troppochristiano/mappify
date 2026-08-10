import { useEffect, useState } from 'react'
import type { MapPoint } from '../lib/api'

/**
 * The name of the place under the cursor.
 *
 * This holds its own state rather than taking it as a prop. Hovering the globe
 * changes one line of text, but with that state in the route, every pointer move
 * onto a new dot re-rendered the whole page — the globe, the open panel and its
 * artist list, all of it. Keeping it here means a hover touches this one node,
 * and a hover costs the same whether a place is open or not: 1.58ms with a panel
 * on screen against 1.53ms without.
 *
 * The globe reaches it through `register`, which hands the setter upward once on
 * mount, so the route can pass the globe a callback that never changes identity.
 */
export function TunedReadout({
  points,
  selectedQid,
  register,
}: {
  points: MapPoint[]
  selectedQid: string | null
  register: (set: ((qid: string | null) => void) | null) => void
}) {
  const [qid, setQid] = useState<string | null>(null)

  useEffect(() => {
    register(setQid)
    return () => register(null)
  }, [register])

  const p = qid ? points.find((q) => q.qid === qid) : null
  if (!p) return null

  return (
    <div className="globe-tuned">
      {p.name}
      <small>
        {p.tracks} tracks · {p.artists} artists
        {p.qid === selectedQid ? '' : ' — click to tune in'}
      </small>
    </div>
  )
}
