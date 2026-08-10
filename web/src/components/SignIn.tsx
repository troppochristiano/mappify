import { useMutation } from '@tanstack/react-query'
import { api } from '../lib/api'

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
      <button className="primary" onClick={() => connect.mutate()} disabled={connect.isPending}>
        {connect.isPending ? 'opening Spotify…' : 'Connect Spotify'}
      </button>
      <p className="fine">
        {local
          ? 'Sign in with the Spotify account you registered the app with. Your library stays on this computer.'
          : 'Spotify allows five accounts per app, and whoever runs this copy has to add yours by hand. If sign-in fails, that is almost always why — ask them to add your Spotify email.'}
      </p>
      {connect.isError && <p className="fine">{(connect.error as Error).message}</p>}
    </div>
  )
}
