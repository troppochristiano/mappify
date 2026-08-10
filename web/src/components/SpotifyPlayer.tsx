import { useEffect, useRef } from 'react'

/**
 * Spotify IFrame Embed API.
 *
 * Chosen over the Web Playback SDK because that one requires Premium and a
 * `streaming` scope; this needs neither and degrades on its own — full track for
 * a Premium user signed into Spotify in this browser, 30-second preview
 * otherwise. `preview_url` was not an option: Spotify removed it in Nov 2024.
 *
 * The embed must stay visible, so it doubles as the now-playing card.
 */

type Controller = {
  loadUri: (uri: string) => void
  play: () => void
  pause: () => void
  destroy: () => void
  addListener: (event: string, cb: (e: { data?: unknown }) => void) => void
}

declare global {
  interface Window {
    onSpotifyIframeApiReady?: (api: {
      createController: (
        el: HTMLElement,
        opts: { uri?: string; width?: string | number; height?: string | number },
        cb: (c: Controller) => void
      ) => void
    }) => void
  }
}

const SCRIPT = 'https://open.spotify.com/embed/iframe-api/v1'

type IFrameApi = Parameters<NonNullable<Window['onSpotifyIframeApiReady']>>[0]

/**
 * The API invokes `onSpotifyIframeApiReady` exactly once, ever. A component that
 * mounts after that — a remount, or StrictMode's deliberate double-mount in dev —
 * would wait forever on a callback that already fired, so the resolved API is
 * cached in a module-level promise instead.
 */
let apiPromise: Promise<IFrameApi> | null = null
function loadIframeApi(): Promise<IFrameApi> {
  if (apiPromise) return apiPromise
  apiPromise = new Promise<IFrameApi>((resolve) => {
    window.onSpotifyIframeApiReady = (api) => resolve(api)
    const script = document.createElement('script')
    script.src = SCRIPT
    script.async = true
    document.body.append(script)
  })
  return apiPromise
}

export type NowPlaying = { uri: string; name: string; artist: string; place: string } | null

export function SpotifyPlayer({ track }: { track: NowPlaying }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const controller = useRef<Controller | null>(null)
  const pending = useRef<string | null>(null)
  const loadedUri = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const attach = (api: IFrameApi) => {
      if (cancelled || !hostRef.current || controller.current) return
      api.createController(hostRef.current, { width: '100%', height: 80 }, (c) => {
        if (cancelled) return
        controller.current = c
        if (pending.current) {
          loadedUri.current = pending.current // keep the guard in step
          c.loadUri(pending.current)
          pending.current = null
        }
      })
    }

    loadIframeApi().then(attach)

    return () => {
      cancelled = true
      controller.current?.destroy()
      controller.current = null
    }
  }, [])

  // Keyed on the URI, never on the track object.
  //
  // The parent rebuilds that object on every render, and it re-renders on every
  // pointer move while the globe is being dragged — so depending on identity
  // reloaded the embed continuously and the song restarted mid-drag. Playback
  // now only changes when the actual track does.
  const uri = track?.uri ?? null

  useEffect(() => {
    if (!uri || uri === loadedUri.current) return
    if (!controller.current) {
      pending.current = uri
      return
    }
    loadedUri.current = uri
    controller.current.loadUri(uri)
    // Autoplay only works after a user gesture. Selecting a place is one, but
    // Safari can still refuse; the embed shows its own play button in that case,
    // so a refusal needs no handling of ours beyond not throwing.
    try {
      controller.current.play()
    } catch {
      /* the embed is left paused, with its own play button */
    }
  }, [uri])

  // The embed already shows the artwork, title and artist, so the card is just
  // the embed. It used to carry a strip above it repeating the same track name
  // and a line of advice about autoplay, which was noise stacked on a widget
  // that says it all itself.
  return (
    <div className="player">
      <div className="player-embed" ref={hostRef} />
    </div>
  )
}
