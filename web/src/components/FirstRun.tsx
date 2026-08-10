import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'

/**
 * The very first screen: what Mappify needs before it can offer a sign-in.
 *
 * Spotify will not talk to an application it has never heard of, so every copy
 * of this needs its own registered app and its own client ID. That is the one
 * step nobody can do for you — but pasting it here is the whole of it, and it
 * replaces "open .env in a text editor", which is where people gave up.
 *
 * The redirect URI is shown with a copy button because it has to match what
 * Spotify has on file *exactly*, and typing it by hand is how you spend twenty
 * minutes on an INVALID_CLIENT error.
 */
export function FirstRun({ redirectUri }: { redirectUri: string }) {
  const qc = useQueryClient()
  const [clientId, setClientId] = useState('')
  const [copied, setCopied] = useState(false)

  const save = useMutation({
    mutationFn: () => api.setClientId(clientId.trim()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['setup'] }),
  })

  const copy = () => {
    navigator.clipboard.writeText(redirectUri)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="signin">
      <h1>Mappify</h1>
      <p>
        One thing first. Spotify needs to know this copy exists, which takes about
        two minutes and is free.
      </p>

      <ol className="steps">
        <li>
          Open{' '}
          <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">
            developer.spotify.com/dashboard
          </a>{' '}
          and click <b>Create app</b>. Name it anything.
        </li>
        <li>
          Paste this as the <b>Redirect URI</b>, exactly:
          <span className="copyrow">
            <code>{redirectUri}</code>
            <button className="ghost" onClick={copy}>{copied ? 'copied' : 'copy'}</button>
          </span>
        </li>
        <li>Tick <b>Web API</b>, save, then copy the <b>Client ID</b> it gives you.</li>
      </ol>

      <input
        className="clientid"
        value={clientId}
        onChange={(e) => setClientId(e.target.value)}
        placeholder="paste your Client ID"
        spellCheck={false}
        autoFocus
      />
      <button
        className="primary"
        onClick={() => save.mutate()}
        disabled={!clientId.trim() || save.isPending}
      >
        {save.isPending ? 'saving…' : 'Continue'}
      </button>
      {save.isError && <p className="fine">{(save.error as Error).message}</p>}

      <p className="fine">
        Your library never leaves this computer. It is read from Spotify and kept
        in a file next to the app.
      </p>
    </div>
  )
}
