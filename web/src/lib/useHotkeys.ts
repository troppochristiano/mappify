import { useEffect, useRef } from 'react'

/**
 * The two keys the app answers to.
 *
 * `/` opens search, because a globe with a search box wants a way to reach it
 * without aiming at a button. Escape backs out of whatever is open, one layer at
 * a time — the ladder is the caller's, since only it knows what is stacked up.
 *
 * One listener on the window rather than handlers on components: what Escape
 * means depends on the whole app's state, not on where the focus happens to be,
 * and a component that is closed cannot listen for the key that opens it.
 */
export function useHotkeys(handlers: { onSlash: () => void; onEscape: () => void }) {
  // Read through a ref so the listener is attached once, rather than being torn
  // down and rebuilt every time a panel opens and the callbacks change identity.
  const ref = useRef(handlers)
  ref.current = handlers

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Anything with a modifier belongs to the browser or the OS.
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const el = e.target as HTMLElement | null
      const typing =
        !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))

      if (e.key === '/' && !typing) {
        // Or Firefox opens its own quick-find over the top of ours.
        e.preventDefault()
        ref.current.onSlash()
        return
      }
      // Escape ignores the typing guard on purpose. Inside a text field it has
      // no default worth keeping, and "Escape gets me out of this" has to work
      // with the cursor in the search box — which is where it will be nine times
      // out of ten.
      if (e.key === 'Escape') ref.current.onEscape()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
