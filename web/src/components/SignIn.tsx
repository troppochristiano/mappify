import { useMutation } from '@tanstack/react-query'
import { api } from '../lib/api'

/**
 * What someone sees before they have connected anything.
 *
 * Every library on this server belongs to one Spotify account, so there is
 * nothing to show a visitor — no demo globe, no other person's map. The honest
 * screen is the door.
 *
 * The five-account cap gets a sentence here rather than only in an error,
 * because the failure it causes happens on Spotify's side and comes back as
 * "invalid_grant", which reads like the app is broken.
 */
export function SignIn() {
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
        Spotify allows five accounts per app, and whoever runs this copy has to add
        yours by hand. If sign-in fails, that is almost always why — ask them to add
        your Spotify email.
      </p>
      {connect.isError && <p className="fine">{String(connect.error)}</p>}
    </div>
  )
}
