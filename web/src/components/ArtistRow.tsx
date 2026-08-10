import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type Artist, type PlaceTrack } from '../lib/api'

/**
 * One artist in a results list.
 *
 * The whole row toggles its tracks — that is the primary, low-risk action, so it
 * gets the largest target. The controls that do something else (play, info) sit
 * inside it and stop propagation, so they never also expand.
 */
export function ArtistRow({
  artist,
  onPlayArtist,
  onPlayTrack,
  onInfo,
  showPlace = true,
  nowPlayingUri = null,
}: {
  artist: Artist
  onPlayArtist: (a: Artist) => void
  onPlayTrack: (t: PlaceTrack) => void
  onInfo: (id: string) => void
  showPlace?: boolean
  nowPlayingUri?: string | null
}) {
  const [open, setOpen] = useState(false)

  const tracks = useQuery({
    queryKey: ['artist', artist.spotify_id],
    queryFn: () => api.artist(artist.spotify_id),
    enabled: open,
  })

  /** Keeps a nested control from also toggling the row. */
  const only = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    fn()
  }

  // MusicBrainz's begin-area means two different things depending on the artist:
  // where a band formed, but where a person was *born*. Nick Drake was born in
  // Yangon and made every record in England, so the label has to say which
  // reading applies rather than implying the music happened there.
  const where = [artist.city, artist.country].filter(Boolean).join(', ')
  const place = where || 'Unknown'
  // "born" is only right when the place came from a birth record. A place you
  // set by hand means whatever you meant by it, so it goes unqualified.
  const pinned = Boolean(artist.origin_pinned)
  const fromWiki = artist.origin_source === 'wikipedia'
  // "born" is only honest for a place that came from a birth record. Both of the
  // other sources mean "where they are from", which is a different claim.
  const placePrefix =
    where && !pinned && !fromWiki && artist.artist_type === 'Person' ? 'born ' : ''

  return (
    <li className={`arow${open ? ' open' : ''}`}>
      <div
        className="arow-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen((v) => !v)
          }
        }}
      >
        <span className="arow-chevron" aria-hidden="true">›</span>

        {/* Decoration, not information — the name beside it already says who
            this is, so it carries no alt text for a screen reader to repeat.
            `lazy` matters: a place can list 200 of these, and only the handful
            actually scrolled to should ever hit the network. */}
        {artist.image_url ? (
          <img className="arow-art" src={artist.image_url} alt="" loading="lazy" decoding="async" />
        ) : (
          <span className="arow-art arow-art-empty" aria-hidden="true" />
        )}

        <span className="arow-text">
          <span className="arow-name">
            {artist.name}
            {artist.fuzzy ? <span className="badge warn">fuzzy</span> : null}
          </span>
          {showPlace && (
            <span
              className="arow-place"
              title={
                pinned
                  ? 'Set by you, overriding everything else'
                  : fromWiki
                    ? 'Where the act is from, per their Wikipedia infobox'
                    : placePrefix
                      ? 'Birthplace, not where the music was made'
                      : undefined
              }
            >
              {placePrefix}
              {place}
              {pinned ? <span className="badge">yours</span> : null}
              {fromWiki ? <span className="badge">wiki</span> : null}
            </span>
          )}
        </span>

        <span className="arow-count">{artist.tracks}</span>

        <span className="arow-actions">
          <button
            className="round-btn play"
            title={`Play something by ${artist.name}`}
            aria-label={`Play a random track by ${artist.name}`}
            onClick={only(() => onPlayArtist(artist))}
          >
            ▶
          </button>
          <button
            className="round-btn"
            title={`Info about ${artist.name}`}
            aria-label={`Info about ${artist.name}`}
            onClick={only(() => onInfo(artist.spotify_id))}
          >
            i
          </button>
        </span>
      </div>

      {open && (
        <ul className="track-list">
          {tracks.isLoading && <li className="track-empty">Loading tracks…</li>}
          {tracks.data?.tracks.map((t) => {
            const uri = `spotify:track:${t.spotify_id}`
            const playing = nowPlayingUri === uri
            return (
              <li key={t.spotify_id}>
                <button
                  className={`track-btn${playing ? ' playing' : ''}`}
                  onClick={() =>
                    onPlayTrack({
                      spotify_id: t.spotify_id,
                      name: t.name,
                      uri,
                      album: t.album,
                      artist: artist.name,
                      city: artist.city,
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
      )}
    </li>
  )
}
