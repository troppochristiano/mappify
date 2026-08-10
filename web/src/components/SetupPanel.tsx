import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useImportStatus } from '../lib/useImportStatus'

/**
 * Connect + import, in the app. Everything here used to be a terminal command.
 *
 * The Spotify limit is stated up front rather than letting a friend hit an
 * opaque rejection on Spotify's own error page: Development Mode allows five
 * authorized users per client ID.
 */
export function SetupPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const setup = useQuery({ queryKey: ['setup'], queryFn: api.setup })
  // The same hook App calls, sharing one query. The poll and the map refresh
  // live there because this panel unmounts when you close it, and an import that
  // stopped updating the globe the moment the panel closed was a real bug.
  const status = useImportStatus()

  // Sign-in is a navigation, not a background call: Spotify has to be able to
  // show you its own consent screen, and it comes back to the server's callback
  // rather than to a port on whichever machine happens to be running this.
  const connect = useMutation({
    mutationFn: api.connect,
    onSuccess: ({ authUrl }) => {
      window.location.href = authUrl
    },
  })
  // No onSuccess invalidation: the server is gone, so there is nothing to refetch.
  const quit = useMutation({ mutationFn: api.quit })
  const startImport = useMutation({
    mutationFn: api.startImport,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['import-status'] }),
  })

  const s = status.data
  const running = Boolean(s?.running)
  const pct = s && s.total ? Math.round((s.done / s.total) * 100) : 0

  return (
    <div className="panel">
      <div className="panel-head">
        <h1>Your library</h1>
        <button className="close" onClick={onClose} aria-label="Close">×</button>
      </div>

      <h2>Spotify</h2>
      {setup.data?.spotify.connected ? (
        <p className="panel-sub">Connected.</p>
      ) : (
        <>
          <p className="panel-sub">
            Connect to import your Liked Songs and playlists. Spotify allows five
            authorized accounts per app, so this only works for accounts added to
            the app's allowlist.
          </p>
          <button className="primary" onClick={() => connect.mutate()} disabled={connect.isPending}>
            {connect.isPending ? 'opening Spotify…' : 'Connect Spotify'}
          </button>
          {connect.isError && (
            <p className="panel-sub" style={{ marginTop: 10 }}>
              {String(connect.error)}
            </p>
          )}
        </>
      )}

      <h2 style={{ marginTop: 20 }}>Origin index</h2>
      <p className="panel-sub">
        {setup.data?.index.kind === 'none' ? (
          <>
            No shared index configured — origins resolve against MusicBrainz at one
            request per second, which is slow but works.
          </>
        ) : (
          <>
            {Number(setup.data?.index.artist_rows ?? 0).toLocaleString()} artists and{' '}
            {Number(setup.data?.index.area_rows ?? 0).toLocaleString()} places, from
            MusicBrainz dump {setup.data?.index.dump_version}. Matching is instant.
          </>
        )}
      </p>

      <h2 style={{ marginTop: 20 }}>Import</h2>
      {running ? (
        <>
          <p className="panel-sub">
            {s?.phase === 'origins-live'
              ? 'Looking up artists the index does not have, at one per second.'
              : s?.message}
          </p>
          <div className="bar">
            <span style={{ width: `${pct}%` }} />
          </div>
          <p className="panel-sub" style={{ marginTop: 6 }}>
            {s?.done ?? 0}
            {s?.total ? ` / ${s.total}` : ''} — {s?.phase}
          </p>
          <button className="ghost" onClick={() => api.cancelImport()}>stop</button>
        </>
      ) : (
        <>
          <button
            className="primary"
            disabled={!setup.data?.spotify.connected || startImport.isPending}
            onClick={() => startImport.mutate()}
          >
            {setup.data?.hasLibrary ? 'Re-import library' : 'Import library'}
          </button>
          {s?.phase === 'error' && <p className="panel-sub" style={{ marginTop: 10 }}>{s.message}</p>}
          {s?.summary && (
            <div className="panel-sub" style={{ marginTop: 12 }}>
              <div>
                {s.summary.tracks} tracks · {s.summary.artists} artists ·{' '}
                {s.summary.playlists} playlists
              </div>
              <div>
                {s.summary.fromIndex} matched from the index
                {s.summary.fromLive ? `, ${s.summary.fromLive} looked up live` : ''}
              </div>
              {!!s.summary.skippedPlaylists?.length && (
                <div style={{ marginTop: 8 }}>
                  {s.summary.skippedPlaylists.length} playlist(s) came back empty because
                  Spotify only returns tracks for playlists you own:
                  <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
                    {s.summary.skippedPlaylists.slice(0, 6).map((p) => (
                      <li key={p.name}>
                        {p.name} — {p.owner ?? 'someone else'} ({p.tracks} tracks)
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* A double-clickable build has no console to close and no window of its
          own, so without this the only way to stop it is Task Manager — and
          closing the tab would leave a server running invisibly. Hidden on a
          hosted instance, where the caller is not the one running it. */}
      {setup.data?.local && (
        <>
          <h2 style={{ marginTop: 20 }}>Quit</h2>
          <p className="panel-sub">
            Mappify stops on its own about a minute after you close the last tab,
            unless an import is still running. This is the impatient version.
          </p>
          <button className="ghost" onClick={() => quit.mutate()} disabled={quit.isPending}>
            {quit.isSuccess ? 'stopped — you can close this tab' : 'Quit Mappify'}
          </button>
        </>
      )}
    </div>
  )
}
