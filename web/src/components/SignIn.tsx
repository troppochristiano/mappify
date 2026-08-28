import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { SpotifyApp } from './SpotifyApp'

/**
 * Whether this page is being viewed on a different hostname than the one the
 * session cookie belongs to, which looks exactly like being signed out.
 *
 * Cookies are scoped by host and ignore the port, and `localhost` and
 * `127.0.0.1` are two hosts however much they are the same machine. Sign-in ends
 * on the API's host, because Spotify redirects the browser to the callback
 * rather than going through the dev proxy — so opening the app on the other name
 * afterwards produces a sign-in screen with no error and nothing to click that
 * helps.
 */
function wrongHostFor(redirectUri: string | undefined) {
  if (!redirectUri) return null
  let apiHost: string
  try {
    apiHost = new URL(redirectUri).hostname
  } catch {
    return null
  }
  if (window.location.hostname === apiHost) return null
  const here = new URL(window.location.href)
  here.hostname = apiHost
  return { apiHost, url: here.toString() }
}

/**
 * What someone sees before they have connected anything.
 *
 * Every library belongs to one Spotify account, so there is nothing to show a
 * visitor — no demo globe, no other person's map. The honest screen is the door.
 *
 * The copy changes for a copy running on your own machine, because the
 * five-account cap is a shared-instance problem: there, the person signing in is
 * the person who registered the app, and warning them about an allowlist they
 * control themselves makes their own laptop sound like somebody else's server.
 */
export function SignIn({ local }: { local: boolean }) {
  const setup = useQuery({ queryKey: ['setup'], queryFn: api.setup })
  const wrongHost = wrongHostFor(setup.data?.redirectUri)
  const connect = useMutation({
    mutationFn: api.connect,
    onSuccess: ({ authUrl }) => {
      window.location.href = authUrl
    },
  })

  return (
    <div className="signin">
      <h1>Mappify</h1>
      <p>
        A globe of your music. Connect Spotify and every artist in your library is
        placed where they are actually from.
      </p>
      {wrongHost && (
        <p className="fine">
          You may already be signed in. This page is on <code>{window.location.hostname}</code>,
          but the session belongs to <code>{wrongHost.apiHost}</code> — different hosts keep
          separate cookies.{' '}
          <a href={wrongHost.url}>Open it on {wrongHost.apiHost}</a>.
        </p>
      )}
      <button className="primary" onClick={() => connect.mutate()} disabled={connect.isPending}>
        {connect.isPending ? 'opening Spotify…' : 'Connect Spotify'}
      </button>
      <p className="fine">
        {local
          ? 'Sign in with the Spotify account you registered the app with. Your library stays on this computer.'
          : 'Spotify allows five accounts per app, and whoever runs this copy has to add yours by hand. If sign-in fails, that is almost always why — ask them to add your Spotify email.'}
      </p>
      {connect.isError && <p className="fine">{(connect.error as Error).message}</p>}
      {/* Sign-in failing because Spotify does not recognise the app is answered
          on Spotify's own page, so there is no error here to hang this off —
          it has to be offered before you click, not after. */}
      <SpotifyApp tone="signin" />
    </div>
  )
}
