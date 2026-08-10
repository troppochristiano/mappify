import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'

/**
 * Move an artist to the place you think they are from.
 *
 * MusicBrainz gives a begin-area, which for a band is where it formed but for a
 * person is where they were born — so Kanye West sits in Atlanta and 2Pac in
 * East Harlem, which is true and not what anyone means. Nothing available fixes
 * it: MusicBrainz's other area field is just the country, Wikidata's work
 * location covers about 5% of the people in a library and residence about 10%,
 * listing seven places for 2Pac and none at all for Kanye.
 *
 * So the correction is yours to make, and it wins over everything else. It moves
 * the dot, the counts and the playlists together, because they all read the same
 * definition of where an artist is.
 */
export function OriginPicker({
  spotifyId,
  current,
  pinned,
}: {
  spotifyId: string
  current: string | null
  pinned: boolean
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const qc = useQueryClient()

  const hits = useQuery({
    queryKey: ['place-search', text],
    queryFn: () => api.placeSearch(text),
    enabled: open && text.trim().length > 1,
  })

  const save = useMutation({
    mutationFn: (qid: string | null) => api.setArtistOrigin(spotifyId, qid),
    onSuccess: () => {
      // Every view counts through the same place, so all of them are now stale.
      qc.invalidateQueries()
      setOpen(false)
      setText('')
    },
  })

  if (!open) {
    return (
      <p className="panel-sub">
        {pinned ? (
          <>
            Set by you to <b>{current ?? '—'}</b>.{' '}
            <button className="linkish" onClick={() => save.mutate(null)}>
              undo
            </button>{' '}
          </>
        ) : null}
        <button className="linkish" onClick={() => setOpen(true)}>
          {pinned ? 'change place' : 'wrong place? set it'}
        </button>
      </p>
    )
  }

  return (
    <div className="origin-picker">
      <input
        type="search"
        autoFocus
        value={text}
        placeholder="Type a city already on the map…"
        onChange={(e) => setText(e.target.value)}
        aria-label="Find a place"
      />
      <ul className="menu-list">
        {hits.data?.places.map((p) => (
          <li key={p.qid}>
            <button className="menu-row" onClick={() => save.mutate(p.qid)}>
              <span className="menu-name">
                {p.name}
                {p.country_iso ? ` · ${p.country_iso}` : ''}
              </span>
              <span className="menu-count">{p.artists}</span>
            </button>
          </li>
        ))}
        {hits.data && !hits.data.places.length && text.trim().length > 1 && (
          <li className="track-empty">
            Nothing on the map by that name — only places the globe can already
            draw can be chosen.
          </li>
        )}
      </ul>
      <button className="ghost" onClick={() => setOpen(false)}>
        cancel
      </button>
    </div>
  )
}
