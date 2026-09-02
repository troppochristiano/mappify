import { useQuery } from '@tanstack/react-query'
import type { PlaceTrack } from '../lib/api'
import { friends as friendsApi } from '../lib/friends'
import { Thumb } from './Thumb'

/**
 * One playlist out of an imported library, opened.
 *
 * The first row in a shared library that can be *entered* rather than looked at.
 * Their artist opens onto a page that reads your library and so cannot exist;
 * their place is a coordinate to fly to; their playlist is a list of tracks, and
 * every one of them plays through the same `spotify:track:` the rest of their
 * music already does.
 *
 * A flat list rather than `FriendArtistRow`, and the reason is correctness
 * rather than taste: that row loads an artist's tracks from
 * `/api/friend-artist-tracks`, which answers with every track they have by that
 * artist — inside a playlist view that would list tracks the playlist does not
 * contain. Grouping by artist also destroys the one thing a playlist is. So the
 * markup and the classes are that component's, deliberately, and nothing else
 * is: the two read as one design without one importing the other.
 *
 * No order but alphabetical, and no apology for it. `track_sources` has no
 * position column on either side of the wire and `added_at` does not travel, so
 * there is no sequence to restore — and insertion order would be an artefact of
 * how the file was written, presented as somebody's sequencing.
 */
export function FriendPlaylistPanel({
  friendId,
  sourceId,
  onPlayTrack,
  nowPlayingUri = null,
}: {
  friendId: number
  /** The id their own file used. Only an address alongside `friendId`. */
  sourceId: number
  onPlayTrack: (t: PlaceTrack) => void
  nowPlayingUri?: string | null
}) {
  const data = useQuery({
    queryKey: ['friend-playlist-tracks', friendId, sourceId],
    queryFn: () => friendsApi.playlistTracks(friendId, sourceId),
  })

  const p = data.data?.playlist

  return (
    <div>
      {data.isLoading && <p className="empty">Loading…</p>}
      {data.error && <p className="panel-sub">{String(data.error)}</p>}

      {p && (
        <>
          <div className="playlist-head">
            <Thumb src={p.image_url} />
            <span className="arow-text">
              <span className="arow-name">{p.name}</span>
              <span className="arow-place">
                {p.missing
                  ? `${p.tracks} tracks · ${p.missing} you don't have`
                  : `${p.tracks} tracks · you have them all`}
              </span>
            </span>
          </div>

          {/* Their Liked Songs is their whole library, so the list is capped
              server-side. Saying so beats a list that quietly stops. */}
          {data.data && data.data.shown < p.tracks && (
            <p className="panel-sub">Showing the first {data.data.shown}.</p>
          )}

          <ul className="track-list playlist-tracks">
            {data.data?.tracks.map((t) => {
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
                        artist: t.artist ?? 'Unknown artist',
                        city: null,
                      })
                    }
                  >
                    <span className="track-mark" aria-hidden="true">{playing ? '■' : '▶'}</span>
                    <span className="track-name">{t.name}</span>
                    {/* Their artist, which a place panel suppresses because you
                        are already looking at the place. Here it is the only
                        thing that says what a track is. */}
                    <span className="track-artist">{t.artist}</span>
                    {!t.mine && <span className="badge">new</span>}
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}
