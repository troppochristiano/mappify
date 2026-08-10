import { Route, Routes, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Home } from './routes/Home'
import { Artist } from './routes/Artist'
import { api } from './lib/api'

function Header({ floating }: { floating: boolean }) {
  const { data } = useQuery({ queryKey: ['stats'], queryFn: api.stats })

  return (
    <header className={floating ? 'app floating' : 'app'}>
      <h1>Mappify</h1>
      <div className="meta">
        <span><b>{data?.tracks ?? '—'}</b> tracks</span>
        <span><b>{data?.artists ?? '—'}</b> artists</span>
        <span><b>{data ? data.trackRows - data.withCountry : '—'}</b> unknown origin</span>
      </div>
    </header>
  )
}

export default function App() {
  const isGlobe = useLocation().pathname === '/'

  return (
    <div className={isGlobe ? 'wrap wrap--bleed' : 'wrap'}>
      <Header floating={isGlobe} />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/artist/:id" element={<Artist />} />
      </Routes>
      {!isGlobe && (
        <footer className="app">
          <p>
            <b>begin-area is not one thing.</b> For groups MusicBrainz records the city
            of formation; for solo artists it is the city of birth. An artist tagged{' '}
            <i>person</i> tells you where that human was born, not where the music was made.
          </p>
          <p>
            Places come from MusicBrainz and Wikidata. Administrative shells that wrap a
            single city are folded into it, so Milan appears once — but real containment
            is kept, so Brooklyn still sits inside New York City and artists with no
            known origin stay in an explicit Unknown bucket rather than being dropped.
          </p>
        </footer>
      )}
    </div>
  )
}
