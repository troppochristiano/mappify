import { useQuery } from '@tanstack/react-query'
import { api, type CollabTrack, type PlaceTrack } from '../lib/api'

/**
 * What one thread between two cities is actually made of.
 *
 * The collab arcs have always been the one thing on the globe you could see and
 * not ask about: a bright line between Detroit and London says two places are
 * connected without ever saying by whom. This is the answer — the tracks that
 * credit artists from both ends, and which artist came from which end.
 *
 * Ordered by how many of the two places a track involves is tempting and wrong;
 * they all involve both, that being the definition of the arc. So they are
 * ordered by name, which is the only ordering that does not imply a ranking
 * nobody computed.
 */

type Props = {
  a: string
  b: string
  /** Open an artist in the same slot this panel occupies. */
  onOpenArtist: (id: string) => void
  /** Play a track, through the same player everything else uses. */
  onPlay: (t: PlaceTrack) => void
  nowPlayingUri: string | null
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

export function CollabPanel({ a, b, onOpenArtist, onPlay, nowPlayingUri }: Props) {
  const detail = useQuery({
    queryKey: ['collab', a, b],
    queryFn: () => api.collab(a, b),
  })

  const d = detail.data

  /** The credited artists from one end of the arc, in credit order. */
  const side = (t: CollabTrack, qid: string) => t.artists.filter((x) => x.qid === qid)

  return (
    <div className="collab-view">
      {/* The dock head says "Collaboration" before the fetch lands, because it
          has to say something the moment you click an arc. Which two places it
          was is the first thing in the body, where arriving late is fine. */}
      {d && <h2 className="dock-subtitle">{`${d.a.name} × ${d.b.name}`}</h2>}

      {detail.isError && (
        <p className="empty">That collaboration could not be loaded.</p>
      )}

      {d && (
        <>
          <p className="panel-sub">
            {plural(d.tracks.length, 'track')} crediting {plural(d.artistCount, 'artist')} across
            the two places.
          </p>

          <ul className="collab-tracks">
            {d.tracks.map((t) => {
              const here = side(t, d.a.qid)
              const there = side(t, d.b.qid)
              const playing = Boolean(t.uri && t.uri === nowPlayingUri)
              return (
                <li key={t.spotify_id} className={`collab-track${playing ? ' playing' : ''}`}>
                  {t.image_url && <img src={t.image_url} alt="" className="collab-cover" />}
                  <div className="collab-body">
                    <div className="collab-title">
                      <span className="collab-name">{t.name}</span>
                      {t.uri && (
                        <button
                          className="round-btn play"
                          title={`Play ${t.name}`}
                          aria-label={`Play ${t.name}`}
                          onClick={() =>
                            onPlay({
                              spotify_id: t.spotify_id,
                              name: t.name,
                              uri: t.uri!,
                              album: t.album,
                              artist: t.artists[0]?.name ?? '',
                              city: null,
                            })
                          }
                        >
                          ▶
                        </button>
                      )}
                    </div>
                    {/* Both ends on one line, in the arc's own order, so the
                        track reads as the sentence the line is drawing:
                        someone here, with someone there. */}
                    <div className="collab-pair">
                      <Names list={here} onOpen={onOpenArtist} />
                      <span className="collab-x" aria-hidden="true">
                        ×
                      </span>
                      <Names list={there} onOpen={onOpenArtist} />
                    </div>
                    {t.album && <div className="collab-album">{t.album}</div>}
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}

/** One end's artists, each a way into their own panel. */
function Names({
  list,
  onOpen,
}: {
  list: { spotify_id: string; name: string }[]
  onOpen: (id: string) => void
}) {
  if (!list.length) return <span className="collab-side collab-none">—</span>
  return (
    <span className="collab-side">
      {list.map((x, i) => (
        <span key={x.spotify_id}>
          {i > 0 && ', '}
          <button className="linkish collab-artist" onClick={() => onOpen(x.spotify_id)}>
            {x.name}
          </button>
        </span>
      ))}
    </span>
  )
}
