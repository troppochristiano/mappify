import { useState } from 'react'
import { useQuery, useMutation, keepPreviousData } from '@tanstack/react-query'
import { api } from '../lib/api'

/**
 * Build a Spotify playlist from the selected place.
 *
 * Two steps on purpose: the count and a sample come first, and nothing is
 * written to Spotify until an explicit confirm. Creating a playlist is not
 * undoable from here, so it never happens on a single stray click.
 *
 * An imported library at the same place is offered as a tick box per library
 * rather than folded in silently: adding somebody else's music to *your*
 * account is a decision, and with several libraries loaded it is several
 * decisions. The one place it is on by default is a place only they have —
 * there the alternative is an empty playlist, which is what the panel used to
 * offer.
 */
export function PlaylistBuilder({
  placeQid,
  iso,
  placeName,
  colourOf,
}: {
  /** Either a place or a whole country — the server takes both. */
  placeQid?: string
  iso?: string
  placeName: string
  /** The hue each library is drawn in, so a row here matches its dots. */
  colourOf?: (id: number) => string
}) {
  const [name, setName] = useState(placeName)
  // Only the boxes that have been touched. The default is derived from the
  // preview rather than stored, so it cannot be left behind holding a library
  // that is no longer at the place you are looking at.
  const [picked, setPicked] = useState<Record<number, boolean>>({})
  const scope = { placeQid, iso }

  /**
   * The place with none of them ticked: your own tracks, and which libraries are
   * offered. Asked first and separately because the default tick is derived from
   * its answer — whether any of this place is yours — and a query cannot be
   * keyed on something only its own result can decide.
   */
  const base = useQuery({
    queryKey: ['playlist-preview', placeQid, iso, ''],
    queryFn: () => api.playlistPreview(scope),
  })
  const shared = base.data?.shared ?? []
  /** Ticked: what you said, or — at a place with none of yours — all of them. */
  const on = (id: number) => picked[id] ?? base.data?.mine === 0
  const chosen = shared.filter((s) => on(s.id)).map((s) => s.id)
  const toggle = (id: number) => setPicked({ ...picked, [id]: !on(id) })

  /** The same question with those libraries in, which only this side can union. */
  const union = useQuery({
    queryKey: ['playlist-preview', placeQid, iso, chosen.join(',')],
    queryFn: () => api.playlistPreview({ ...scope, friends: chosen }),
    enabled: chosen.length > 0,
    // The count and the list would otherwise blank out for a moment on every
    // tick, which reads as the panel reloading rather than a number changing.
    placeholderData: keepPreviousData,
  })
  const p = (chosen.length ? union.data : null) ?? base.data

  const create = useMutation({
    mutationFn: () => api.playlistCreate({ ...scope, name, friends: chosen }),
  })

  // While a tick is in flight the exact union is not known yet, so the button
  // carries the sum instead. It can only ever be too high, by however many of
  // their tracks you already have, and it settles a moment later.
  const settled = p?.included.join(',') === chosen.join(',')
  const total = settled
    ? (p?.total ?? 0)
    : (p?.mine ?? 0) + shared.filter((s) => on(s.id)).reduce((n, s) => n + s.tracks, 0)

  return (
    <div>
      {base.isLoading && <p className="empty">Counting tracks…</p>}

      {p && !create.data && (
        <>
          <p className="panel-sub">
            {p.mine > 0 ? (
              <>
                <b>{p.mine}</b> tracks by artists from {placeName}
                {p.places.length > 2
                  ? ` and ${p.places.length - 1} nearby places`
                  : p.places.length === 2
                    ? ' and one nearby place'
                    : ''}
                .
              </>
            ) : shared.length ? (
              // Not a failure, and not an empty playlist either: the tracks are
              // here, they are simply somebody else's.
              <>Nothing of yours is from {placeName}, but an imported library has music here.</>
            ) : (
              <>Nothing in your library is from {placeName}.</>
            )}
          </p>

          {shared.length > 0 && (
            <ul className="share-picks">
              {shared.map((s) => (
                <li key={s.id}>
                  <label className="share-pick">
                    <input type="checkbox" checked={on(s.id)} onChange={() => toggle(s.id)} />
                    {colourOf && (
                      <span
                        className="owner-dot"
                        style={{ color: colourOf(s.id) }}
                        aria-hidden="true"
                      />
                    )}
                    <span className="share-pick-main">
                      <span className="menu-name">{s.name}</span>
                      <span className="panel-sub" style={{ margin: 0 }}>
                        {s.missing
                          ? `${s.tracks} here · ${s.missing} you don't have`
                          : `${s.tracks} here · you have them all`}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}

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
                    {/* Whose it is, only where that is not you. */}
                    {t.who ? ` · from ${t.who}` : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {total > p.sample.length && (
            <p className="panel-sub">…and {total - p.sample.length} more</p>
          )}
          <button
            className="primary"
            disabled={create.isPending || !total}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'creating…' : `Create private playlist (${total})`}
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
