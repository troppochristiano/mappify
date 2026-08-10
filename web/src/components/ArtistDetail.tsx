import { useQuery } from '@tanstack/react-query'
import { api, type PlaceTrack } from '../lib/api'
import { OriginPicker } from './OriginPicker'

/**
 * Artist info. Rendered inside the globe's panel rather than as its own page,
 * so opening it never leaves the globe.
 */
export function ArtistDetail({
  id,
  onPlay,
  nowPlayingUri = null,
}: {
  id: string
  onPlay?: (track: PlaceTrack) => void
  nowPlayingUri?: string | null
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['artist', id],
    queryFn: () => api.artist(id),
  })

  if (isLoading) return <p className="empty">Loading…</p>
  if (error) return <p className="empty">{String(error)}</p>
  if (!data) return null

  const a = data.artist
  const disagree = a.mb_country && a.wd_country && a.mb_country !== a.wd_country

  return (
    <>
      <h2>Origin</h2>
      <OriginPicker
        spotifyId={id}
        current={a.city ?? null}
        pinned={Boolean(a.origin_pinned)}
      />
      <table>
        <tbody>
          <tr><td>city</td><td>{a.city ?? '—'}</td></tr>
          <tr><td>country</td><td>{a.country ?? '—'}</td></tr>
          <tr><td>ISO</td><td>{a.mb_country_iso ?? '—'}</td></tr>
          <tr><td>type</td><td>{a.artist_type ?? '—'}</td></tr>
          <tr><td>status</td><td>{a.status ?? '—'}</td></tr>
        </tbody>
      </table>

      <h2 style={{ marginTop: 18 }}>Provenance</h2>
      <table>
        <tbody>
          <tr>
            <td>MusicBrainz</td>
            <td>{[a.mb_city, a.mb_country].filter(Boolean).join(', ') || '—'}</td>
          </tr>
          <tr>
            <td>Wikidata</td>
            <td>{[a.wd_city, a.wd_country].filter(Boolean).join(', ') || '—'}</td>
          </tr>
        </tbody>
      </table>

      {disagree && (
        <p className="panel-sub">
          The two sources disagree. MusicBrainz records whatever area someone entered —
          sometimes a city or region where Wikidata gives the sovereign state. Both are kept.
        </p>
      )}
      {a.artist_type === 'Person' && a.city && (
        <p className="panel-sub">
          This is a person, so <i>{a.city}</i> is where they were born — not necessarily
          where the music was made.
        </p>
      )}
      {a.fuzzy ? (
        <p className="panel-sub">
          Matched by name rather than by Spotify URL. Distrust this origin.
        </p>
      ) : null}

      <h2 style={{ marginTop: 18 }}>{data.tracks.length} tracks in your library</h2>
      <ul className="track-list" style={{ paddingLeft: 0 }}>
        {data.tracks.map((t) => {
          const uri = `spotify:track:${t.spotify_id}`
          const playing = nowPlayingUri === uri
          return (
            <li key={t.spotify_id}>
              <button
                className={`track-btn${playing ? ' playing' : ''}`}
                onClick={() =>
                  onPlay?.({
                    spotify_id: t.spotify_id,
                    name: t.name,
                    uri,
                    album: t.album,
                    artist: a.name,
                    city: a.city,
                  })
                }
              >
                <span className="track-mark" aria-hidden="true">{playing ? '▮' : '▶'}</span>
                <span className="track-name">{t.name}</span>
                {t.position > 0 ? <span className="badge">feat</span> : null}
                <span className="track-album">{t.album}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}
