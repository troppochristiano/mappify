import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { PlaceTrack } from '../lib/api'
import { friends as friendsApi, type FriendArtist } from '../lib/friends'
import { Thumb } from './Thumb'

/**
 * One artist from an imported library, shaped like one of your own.
 *
 * A shared library used to list as bare tracks, which made it read as a
 * different kind of thing purely because it was drawn differently — everywhere
 * else in the app a place lists artists and an artist opens onto its tracks.
 * Same markup as ArtistRow, so the two lists in a place panel are one list with
 * a heading between them rather than two designs.
 *
 * A sibling rather than ArtistRow made generic. ArtistRow is typed to `Artist`
 * and reads `fuzzy`, `origin_pinned`, `origin_source` and `artist_type` — none
 * of which a shared file carries — and its track rows render `album` and
 * `position`, which theirs also lack. Making it serve both would mean a
 * loadTracks prop, a widened artist type and a render prop for the track body:
 * three seams cut through a component used in four places, for one caller.
 *
 * Three real differences from ArtistRow, and only three:
 *
 *   - the tracks come from the friend routes;
 *   - the badge marks what you are *missing* rather than a featured credit,
 *     because the discovery is the whole reason to look at somebody else's
 *     library;
 *   - it has no action buttons. Info would need an artist page, and there is
 *     none for somebody else's artist — /api/artist reads your library, which
 *     SearchPanel already establishes by disabling the same control. Play would
 *     need a track chosen before any are loaded, and the row opens onto the
 *     tracks anyway, so the buttons would be a worse route to the same place.
 */
export function FriendArtistRow({
  friendId,
  artist,
  onPlayTrack,
  nowPlayingUri = null,
}: {
  friendId: number
  artist: FriendArtist
  onPlayTrack: (t: PlaceTrack) => void
  nowPlayingUri?: string | null
}) {
  const [open, setOpen] = useState(false)

  const tracks = useQuery({
    queryKey: ['friend-artist-tracks', friendId, artist.spotify_id],
    queryFn: () => friendsApi.artistTracks(friendId, artist.spotify_id),
    // Only once opened, which is the point of grouping: a place with forty of
    // their artists costs one request until you ask for one of them.
    enabled: open,
  })

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

        <Thumb src={artist.image_url} />

        <span className="arow-text">
          <span className="arow-name">{artist.name}</span>
          {/* The second line your own rows use for an artist's origin. Repeating
              the place would be the one thing those rows deliberately suppress —
              it is the city you are already looking at — so it carries the
              question you actually have about somebody else's artist instead. */}
          <span className="arow-place">
            {artist.missing
              ? `${artist.missing} of ${artist.tracks} new to you`
              : 'all in your library'}
          </span>
        </span>

        <span className="arow-count">{artist.tracks}</span>

        {/* Empty, and present on purpose. Your rows keep a column for the play
            and info buttons — hidden at rest by opacity, so the space is still
            reserved — and without the same column here the two lists would put
            their counts in different places and stop reading as one list. */}
        <span className="arow-actions" aria-hidden="true" />
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
                      // A shared file carries neither an album nor a per-track
                      // cover. Saying so beats inventing them.
                      album: null,
                      artist: artist.name,
                      city: null,
                    })
                  }
                >
                  <span className="track-mark" aria-hidden="true">{playing ? '■' : '▶'}</span>
                  <span className="track-name">{t.name}</span>
                  {!t.mine && <span className="badge">new</span>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </li>
  )
}
