import { useEffect } from 'react'

/**
 * Tells the server this tab is open, so it can stop when the last one closes.
 *
 * A double-clickable Mappify has no window of its own — the tab *is* the window,
 * and there is otherwise no way for the server to know whether anyone is still
 * there. Without this it runs invisibly until the machine reboots.
 *
 * Must be called from a component that is always mounted, and above any early
 * return: a tab sitting on the sign-in screen is still an open tab.
 */
const BEAT_MS = 10_000

/**
 * Per tab, and stable across a reload.
 *
 * sessionStorage rather than localStorage: session storage is scoped to the tab,
 * so two windows are two identities and closing one does not look like closing
 * both. It also survives a refresh, so a reloading tab re-registers as itself
 * rather than appearing as a new arrival while the old one times out.
 */
function tabId(): string {
  const key = 'mappify.tab'
  let id = sessionStorage.getItem(key)
  if (!id) {
    id = crypto.randomUUID()
    sessionStorage.setItem(key, id)
  }
  return id
}

export function useHeartbeat(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    const id = tabId()
    const beat = () => {
      // keepalive so a beat in flight when the tab is closing still arrives.
      fetch(`/api/alive?tab=${encodeURIComponent(id)}`, { keepalive: true }).catch(() => {})
    }

    beat()
    const timer = setInterval(beat, BEAT_MS)

    // Browsers throttle timers in hidden tabs — Chrome to roughly once a minute
    // — so coming back to a tab should say so immediately rather than waiting
    // for the next tick. pageshow covers a restore from the back/forward cache,
    // where the interval may not resume at all.
    const wake = () => {
      if (document.visibilityState === 'visible') beat()
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('pageshow', wake)
    window.addEventListener('focus', wake)
    window.addEventListener('online', beat)

    // Fires on close *and* on reload, which is why the server treats it as
    // "shorten this tab's window" rather than "this tab is gone".
    const leave = () => {
      navigator.sendBeacon(`/api/bye?tab=${encodeURIComponent(id)}`)
    }
    window.addEventListener('pagehide', leave)

    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('pageshow', wake)
      window.removeEventListener('focus', wake)
      window.removeEventListener('online', beat)
      window.removeEventListener('pagehide', leave)
    }
  }, [enabled])
}
