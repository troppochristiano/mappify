/**
 * A harness for the playlist panel, with no server and no sign-in behind it.
 *
 * The two states worth looking at are both about an imported library: a place
 * where you have music and they do too, and a place where only they do — which
 * is the one that used to offer an empty playlist. Reaching either in the real
 * app needs a Spotify session, an import, and a `.mappify` file from somebody
 * else, so `fetch` is answered from a table here instead.
 *
 * Dev only. Not imported by the app, and not in the production bundle.
 */
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PlaylistBuilder } from './components/PlaylistBuilder'
import './styles.css'

const LIBS = [
  { id: 3, name: 'Leonardo', tracks: 65, missing: 65 },
  { id: 5, name: 'Anna', tracks: 12, missing: 9 },
]

const track = (i: number, who: string | null, city: string) => ({
  track: `Track ${i}`,
  artist: `Artist ${i}`,
  city,
  who,
})

/** Yours, theirs, and what the union of a tick comes to. */
const CASES: Record<string, { mine: number; city: string; shared: typeof LIBS }> = {
  Q84: { mine: 287, city: 'London', shared: LIBS },
  Q39121: { mine: 0, city: 'Leeds', shared: LIBS },
}

window.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input), location.origin)
  const c = CASES[url.searchParams.get('placeQid') ?? 'Q84']
  const on = url.searchParams.getAll('friend').map(Number)
  const picked = c.shared.filter((s) => on.includes(s.id))
  // No overlap modelled: the count the panel shows is the server's, and what is
  // being checked here is that it renders what it is handed.
  const total = c.mine + picked.reduce((n, s) => n + s.tracks, 0)
  const sample = [
    ...Array.from({ length: Math.min(c.mine, 4) }, (_, i) => track(i + 1, null, c.city)),
    ...picked.flatMap((s) => [track(90 + s.id, s.name, c.city)]),
  ]
  return new Response(
    JSON.stringify({
      total,
      mine: c.mine,
      sample,
      places: [c.city, 'Nearby'],
      included: picked.map((s) => s.id),
      shared: c.shared,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  )
}) as typeof fetch

const qc = new QueryClient()
const colourOf = (id: number) => (id === 3 ? '#ff7ac6' : '#7ad1ff')

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={qc}>
    <div style={{ display: 'flex', gap: 24, padding: 24, alignItems: 'flex-start' }}>
      <div style={{ width: 336 }}>
        <h2>A place you both have</h2>
        <PlaylistBuilder placeQid="Q84" placeName="London" colourOf={colourOf} />
      </div>
      <div style={{ width: 336 }}>
        <h2>A place only they have</h2>
        <PlaylistBuilder placeQid="Q39121" placeName="Leeds" colourOf={colourOf} />
      </div>
    </div>
  </QueryClientProvider>
)
