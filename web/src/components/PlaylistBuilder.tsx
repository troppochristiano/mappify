import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { api } from '../lib/api'

/**
 * Build a Spotify playlist from the selected place.
 *
 * Two steps on purpose: the count and a sample come first, and nothing is
 * written to Spotify until an explicit confirm. Creating a playlist is not
 * undoable from here, so it never happens on a single stray click.
 */
export function PlaylistBuilder({
  placeQid,
  iso,
  placeName,
  onClose,
}: {
  /** Either a place or a whole country — the server takes both. */
  placeQid?: string
  iso?: string
  placeName: string
  onClose: () => void
}) {
  const [name, setName] = useState(placeName)
  const scope = { placeQid, iso }
  const preview = useQuery({
    queryKey: ['playlist-preview', placeQid, iso],
    queryFn: () => api.playlistPreview(scope),
  })
  const create = useMutation({
    mutationFn: () => api.playlistCreate({ ...scope, name }),
  })

  const p = preview.data

  return (
    <div className="panel">
      <div className="panel-head">
        <h1>New playlist</h1>
        <button className="close" onClick={onClose} aria-label="Close">×</button>
      </div>

      {preview.isLoading && <p className="empty">Counting tracks…</p>}

      {p && !create.data && (
        <>
          <p className="panel-sub">
            <b>{p.total}</b> tracks by artists from {placeName}
            {p.places.length > 1 ? ` and ${p.places.length - 1} nearby places` : ''}.
          </p>
          <input
            type="search"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Playlist name"
            style={{ width: '100%', marginBottom: 12 }}
          />
          <ul className="artist-list">
            {p.sample.map((t, i) => (
              <li key={i} className="artist-row">
                <span className="artist-row-main">
                  <span className="artist-name">{t.track}</span>
                  <span className="panel-sub" style={{ margin: 0 }}>
                    {t.artist} — {t.city}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {p.total > p.sample.length && (
            <p className="panel-sub">…and {p.total - p.sample.length} more</p>
          )}
          <button
            className="primary"
            disabled={create.isPending || !p.total}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'creating…' : `Create private playlist (${p.total})`}
          </button>
          {create.error && <p className="panel-sub">{String(create.error)}</p>}
        </>
      )}

      {create.data && (
        <>
          <p className="panel-sub">
            Created <b>{create.data.name}</b> with {create.data.added} tracks.
          </p>
          {create.data.url && (
            <a className="primary" href={create.data.url} target="_blank" rel="noreferrer">
              Open in Spotify
            </a>
          )}
        </>
      )}
    </div>
  )
}
