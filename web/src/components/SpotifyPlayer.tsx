import { useEffect, useRef, useState } from 'react'

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
    /** Installed by index.html, so the script fetch starts at parse time. */
    __spotifyIframeApi?: Promise<IFrameApi>
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
  // index.html starts the script while the head is still being parsed and hands
  // the resolved API over through this global. Injecting our own would be a
  // second copy of a script that has already run, and would overwrite the
  // callback it resolves through. The fallback is the original path, kept for
  // any host page without the shim.
  apiPromise =
    window.__spotifyIframeApi ??
    new Promise<IFrameApi>((resolve) => {
      window.onSpotifyIframeApiReady = (api) => resolve(api)
      const script = document.createElement('script')
      script.src = SCRIPT
      script.async = true
      document.body.append(script)
    })
  return apiPromise
}

/**
 * A track the controller is built around at mount, purely so the embed document
 * and everything behind it are fetched while nothing is playing.
 *
 * `createController` with no uri leaves the iframe genuinely cold: measured, the
 * first `loadUri` then spent 2.9s fetching the embed document, against 0.6s for
 * the same swap on a controller that had been warmed. That gap is the whole
 * reason the first play felt slow and every play after it did not.
 *
 * Never played and never visible — `play()` is unreachable from this path and
 * the card is collapsed to zero height until a real track arrives. A constant
 * rather than something from the library, deliberately: it has to be available
 * before any request has resolved, and which track it is cannot matter to
 * something nobody hears or sees.
 */
const WARM_URI = 'spotify:track:7ouMYWpwJ422jRcDASZB7P'

export type NowPlaying = { uri: string; name: string; artist: string; place: string } | null

export function SpotifyPlayer({ track, autoplay }: { track: NowPlaying; autoplay: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const controller = useRef<Controller | null>(null)
  const pending = useRef<string | null>(null)
  const loadedUri = useRef<string | null>(null)
  /**
   * Through a ref, so the effect below can stay keyed on the URI alone.
   *
   * The setting says what happens when a track *arrives*. Reading it as a
   * dependency would make flipping the toggle reload whatever is playing, which
   * is the one thing a preference about starting playback must not do.
   */
  const autoplayRef = useRef(autoplay)
  autoplayRef.current = autoplay
  /**
   * Latched the first time a URI reaches the controller, and never cleared.
   *
   * `track` goes null for as long as it takes the next one to arrive — the route
   * clears its manual pick on a place change, and the place's own track is a
   * fetch — while the embed carries on playing the previous one. Collapsing the
   * card in that gap took the dock down 80px and brought it back up a moment
   * later, on every track change.
   */
  const [hasPlayed, setHasPlayed] = useState(false)

  useEffect(() => {
    let cancelled = false

    const attach = (api: IFrameApi) => {
      if (cancelled || !hostRef.current || controller.current) return
      // A real track that landed while the API was still loading wins over the
      // warm-up — same warm iframe, one swap fewer. `loadedUri` and `hasPlayed`
      // are only ever set from a real track, never from WARM_URI, so the first
      // genuine loadUri still fires, still plays, and still opens the card.
      const initial = pending.current ?? WARM_URI
      if (pending.current) {
        loadedUri.current = pending.current // keep the guard in step
        pending.current = null
        setHasPlayed(true)
      }
      api.createController(hostRef.current, { uri: initial, width: '100%', height: 80 }, (c) => {
        if (cancelled) return
        controller.current = c
        if (pending.current) {
          loadedUri.current = pending.current
          c.loadUri(pending.current)
          pending.current = null
          setHasPlayed(true)
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
    setHasPlayed(true)
    // Autoplay only works after a user gesture. Selecting a place is one, but
    // Safari can still refuse; the embed shows its own play button in that case,
    // so a refusal needs no handling of ours beyond not throwing. Turning the
    // setting off lands in exactly the same place, deliberately: the track is
    // loaded and named, waiting on the embed's own button.
    if (!autoplayRef.current) return
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
  // Collapsed rather than unmounted before the first track. The controller is
  // expensive to build and the API hands one out per host element, so a card
  // that came and went would take the embed with it; and an empty 80px slot
  // under the dock is a widget about nothing, holding the dock off the bottom
  // edge for no reason.
  //
  // Only before the first track, though: once the embed holds one it holds it
  // for the rest of the session, so from there on the card stays.
  const visible = Boolean(track) || hasPlayed

  return (
    <div
      className={`player${visible ? '' : ' player--idle'}`}
      aria-hidden={visible ? undefined : true}
    >
      <div className="player-embed" ref={hostRef} />
    </div>
  )
}
