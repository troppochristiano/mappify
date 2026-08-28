import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'

/**
 * Which registered Spotify application this copy signs in through, and the way
 * to point it at a different one.
 *
 * It lives on the sign-in screen as well as in the library panel, because the
 * failure it exists for locks you out of the panel: an app Spotify no longer
 * recognises is answered with a bare `client_id: Invalid` on Spotify's own page,
 * before any of this code runs, and a screen that only offers "Connect Spotify"
 * has nothing to say to that. Being unable to change the app without finding and
 * editing `.env` is what made a two-minute fix a long evening.
 *
 * Hidden on a hosted instance: there the environment owns the client id, the
 * endpoint refuses, and the client id is not the visitor's business anyway.
 */
export function SpotifyApp({ tone }: { tone: 'panel' | 'signin' }) {
  const qc = useQueryClient()
  const setup = useQuery({ queryKey: ['setup'], queryFn: api.setup })
  const sub = tone === 'panel' ? 'panel-sub' : 'fine'

  // A deliberate reveal rather than an input sitting open: changing the app
  // invalidates the tokens already stored, which is not something to do by
  // tabbing into a field.
  const [editing, setEditing] = useState(false)
  const [next, setNext] = useState('')
  const change = useMutation({
    mutationFn: () => api.setClientId(next.trim(), true),
    onSuccess: () => {
      setEditing(false)
      setNext('')
      qc.invalidateQueries({ queryKey: ['setup'] })
    },
  })

  const s = setup.data
  if (!s?.local || !s.clientId) return null

  if (!editing) {
    return (
      <p className={sub}>
        Signing in through app <code>{s.clientId}</code>.{' '}
        <button className="linkish" onClick={() => setEditing(true)}>
          Use a different one
        </button>
      </p>
    )
  }

  return (
    <>
      <p className={sub}>
        The client ID of an app at{' '}
        <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">
          developer.spotify.com/dashboard
        </a>{' '}
        whose redirect URI is exactly <code>{s.redirectUri}</code>.
      </p>

      {s.clientIdSource === 'env' ? (
        // Refusing here rather than letting the request fail: on this instance
        // .env is the authority and saying so is more use than an error.
        <p className={sub}>
          <code>SPOTIFY_CLIENT_ID</code> in <code>.env</code> is setting it. Remove that
          line to change it here instead.{' '}
          <button className="linkish" onClick={() => setEditing(false)}>
            cancel
          </button>
        </p>
      ) : (
        <>
          <input
            className="clientid"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder="paste the new Client ID"
            spellCheck={false}
            autoFocus
          />
          <p className={sub}>
            Signs you out — the tokens you have were issued by the old app. Your
            library stays where it is.
          </p>
          <button
            className="primary"
            onClick={() => change.mutate()}
            disabled={!next.trim() || change.isPending}
          >
            {change.isPending ? 'saving…' : 'Use this app'}
          </button>{' '}
          <button
            className="ghost"
            onClick={() => {
              setEditing(false)
              setNext('')
              change.reset()
            }}
          >
            cancel
          </button>
          {change.isError && <p className={sub}>{(change.error as Error).message}</p>}
        </>
      )}
    </>
  )
}
