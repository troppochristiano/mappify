import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/**
 * The dock's sections.
 *
 * These are destinations, not toggles — everything the app can show, in one
 * list, at the foot of one card. What used to be a floating toolbar at the top
 * of the map and two sheets at its edges is this bar and the body above it.
 */
export type DockTab = 'places' | 'search' | 'library' | 'compare' | 'options'

/**
 * Line icons, drawn here rather than pulled in.
 *
 * Five shapes is not a dependency. They share one geometry — a 24 box, no fill,
 * a 1.6 stroke in the current colour — so they weigh the same next to each
 * other, and a tab that is dim or lit needs no second copy of the icon.
 */
const ICON: Record<DockTab, ReactNode> = {
  places: (
    <>
      <path d="M12 21s7-5.7 7-10.5a7 7 0 1 0-14 0C5 15.3 12 21 12 21Z" />
      <circle cx="12" cy="10.5" r="2.4" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.6-4.6" />
    </>
  ),
  library: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="2.2" />
    </>
  ),
  compare: (
    <>
      <circle cx="9.5" cy="12" r="5.8" />
      <circle cx="14.5" cy="12" r="5.8" />
    </>
  ),
  options: (
    <>
      <path d="M4 8.5h8M17 8.5h3M4 15.5h3M12 15.5h8" />
      <circle cx="14.5" cy="8.5" r="2.2" />
      <circle cx="9" cy="15.5" r="2.2" />
    </>
  ),
}

export const DOCK_TABS: { id: DockTab; label: string }[] = [
  { id: 'places', label: 'places' },
  { id: 'search', label: 'search' },
  { id: 'library', label: 'library' },
  { id: 'compare', label: 'compare' },
  { id: 'options', label: 'options' },
]

/** Mirrors `--dock-edge` and `--dock-gap` in styles.css. */
const EDGE = 12
const GAP = 10

/** Where a released drag settles: shut, about half, and everything there is. */
const HALF = 0.45

/** A press this short and this still is a click, not a drag of no length. */
const CLICK_PX = 6
const CLICK_MS = 400

/** Past this, the direction you threw the sheet outranks where you let go. */
const FLICK = 0.5 // px per ms

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

type Props = {
  tab: DockTab
  open: boolean
  /** A click on the bar. The tab you are already on collapses the dock. */
  onTab: (t: DockTab) => void
  /**
   * An arrow key on the bar.
   *
   * Separate from `onTab` on purpose: arrowing along a collapsed bar is reading
   * it, not committing to it, so it swaps the tab without opening anything.
   */
  onSelect: (t: DockTab) => void
  /** Told when a drag settles somewhere `open` does not already describe. */
  onOpenChange: (open: boolean) => void
  /**
   * The dock's outer height, reported on every change.
   *
   * The camera needs it: a sheet pulled to the top of the window covers a
   * column, and the same sheet pulled down covers a strip, and only the caller
   * knows which of those to tell the globe about.
   */
  onHeight: (px: number) => void
  title: ReactNode
  /** Present only while a pushed view is on top of the tab. */
  onBack?: () => void
  /** Counts on the bar — today just the filter chips, on `search`. */
  badges?: Partial<Record<DockTab, number>>
  children: ReactNode
}

/**
 * The pull-up sheet above the player: a grip, a head, a scrolling body, and a
 * tab bar that never leaves.
 *
 * It owns no application state. The globe opens it (clicking an arc pushes a
 * collaboration onto it) and so does the `/` hotkey, so `tab` and `open` live
 * with the things that drive them. What it does own is its own height, because
 * that is a continuous thing you drag rather than a boolean anyone else has an
 * opinion about — the boolean is derived from it and handed back up.
 *
 * The body is kept mounted at zero height rather than unmounted. A height that
 * animates has to have something to animate to, and it means the lists inside
 * keep their fetched data across a collapse instead of reloading — which is
 * what used to make the card flinch when you came back to it. `inert` keeps the
 * hidden content out of the tab order and out of the browser's own find.
 */
export function Dock({
  tab,
  open,
  onTab,
  onSelect,
  onOpenChange,
  onHeight,
  title,
  onBack,
  badges,
  children,
}: Props) {
  const dockRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)

  /** The rendered body height. The card's height follows from it. */
  const [height, setHeight] = useState(0)
  /** Where a click reopens to: the size you last pulled it to. */
  const openHeight = useRef(0)
  const [dragging, setDragging] = useState(false)
  /**
   * Whether the sheet is allowed to animate yet.
   *
   * A link to a place opens the dock, and that first height has to be *there*
   * rather than travelled to — otherwise following a link plays a 260ms reveal
   * of something you already asked for. So the transition is switched on a
   * frame later, once the opening size has been applied.
   */
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true))
    return () => cancelAnimationFrame(id)
  }, [])

  /** The tallest the body may be, measured rather than worked out on paper. */
  const avail = useRef(0)
  /** Everything in the card that is not the body: grip, head, bar, borders. */
  const chrome = useRef(0)

  const measure = useCallback(() => {
    const dock = dockRef.current
    const body = bodyRef.current
    if (!dock || !body) return
    const stack = dock.parentElement
    const route = stack?.parentElement
    const player = stack?.querySelector<HTMLElement>('.player')
    if (!stack || !route) return
    // The dock minus its body is exactly grip + head + bar + borders, whatever
    // those happen to measure — which is the point, since giving the tabs icons
    // changed the bar's height and nothing here had to be told.
    chrome.current = dock.offsetHeight - body.offsetHeight
    avail.current = Math.max(
      0,
      route.clientHeight - EDGE * 2 - chrome.current - GAP - (player?.offsetHeight ?? 0)
    )
  }, [])

  useLayoutEffect(() => {
    measure()
    const stack = dockRef.current?.parentElement
    const route = stack?.parentElement
    if (!route || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      measure()
      // A window that shrank under the sheet takes the sheet down with it.
      setHeight((h) => (h > avail.current ? avail.current : h))
    })
    ro.observe(route)
    // The player too: it collapses to nothing with no track and slides back in
    // with one, and `measure` subtracts its height. Without this the sheet keeps
    // whichever cap it was given when it last happened to be measured, so it
    // either stops 80px short of the top or gets pushed off the bottom.
    const player = stack?.querySelector<HTMLElement>('.player')
    if (player) ro.observe(player)
    return () => ro.disconnect()
  }, [measure])

  // `open` is the boolean everything else drives — a tab click, `/`, a deep
  // link, a pushed view. A drag reports its own result back up, so this guard
  // is what stops that report bouncing straight back down as a re-open.
  useLayoutEffect(() => {
    // Measured before the update rather than inside it: a state updater has to
    // be free of side effects, and StrictMode runs them twice to say so.
    measure()
    setHeight((h) => (open === h > 0 ? h : open ? openHeight.current || avail.current : 0))
  }, [open, measure])

  // From the state and not from the DOM. `offsetHeight` right after a commit is
  // the height the transition is starting *from*, so reading it here would tell
  // the camera where the sheet has just been rather than where it is going.
  useEffect(() => {
    onHeight(height > 0 ? chrome.current + height : chrome.current)
  }, [height, tab, onHeight])

  const settle = (to: number) => {
    setHeight(to)
    if (to > 0) openHeight.current = to
    if (to > 0 !== open) onOpenChange(to > 0)
  }

  const drag = useRef({ y: 0, h: 0, t: 0, lastY: 0, lastT: 0, v: 0 })

  const onGripDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    // Captured, so a fast pull that leaves the window still tracks.
    e.currentTarget.setPointerCapture(e.pointerId)
    measure()
    const now = e.timeStamp
    drag.current = { y: e.clientY, h: height, t: now, lastY: e.clientY, lastT: now, v: 0 }
    setDragging(true)
  }

  const onGripMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragging) return
    const d = drag.current
    const dt = e.timeStamp - d.lastT
    if (dt > 0) d.v = (d.lastY - e.clientY) / dt // upward is positive
    d.lastY = e.clientY
    d.lastT = e.timeStamp
    // Up is taller: the sheet comes with you.
    setHeight(clamp(d.h + (d.y - e.clientY), 0, avail.current))
  }

  const onGripUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragging) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    setDragging(false)
    const d = drag.current
    const moved = Math.abs(e.clientY - d.y)

    if (moved < CLICK_PX && e.timeStamp - d.t < CLICK_MS) {
      // Reopens to the size you last pulled it to, not always to full: a sheet
      // that forgets is one you have to resize every time you glance away.
      settle(height > 0 ? 0 : openHeight.current || avail.current)
      return
    }

    const snaps = [0, Math.round(avail.current * HALF), avail.current]
    let i = 0
    for (let n = 1; n < snaps.length; n++) {
      if (Math.abs(snaps[n] - height) < Math.abs(snaps[i] - height)) i = n
    }
    if (Math.abs(d.v) > FLICK) i = clamp(i + (d.v > 0 ? 1 : -1), 0, snaps.length - 1)
    settle(snaps[i])
  }

  const onBarKey = (e: React.KeyboardEvent) => {
    const i = DOCK_TABS.findIndex((t) => t.id === tab)
    let next = -1
    if (e.key === 'ArrowRight') next = (i + 1) % DOCK_TABS.length
    else if (e.key === 'ArrowLeft') next = (i - 1 + DOCK_TABS.length) % DOCK_TABS.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = DOCK_TABS.length - 1
    else return
    e.preventDefault()
    const id = DOCK_TABS[next].id
    onSelect(id)
    barRef.current?.querySelector<HTMLElement>(`#dock-tab-${id}`)?.focus()
  }

  const isOpen = height > 0
  const index = DOCK_TABS.findIndex((t) => t.id === tab)

  return (
    <div
      className={`dock${isOpen ? ' dock--open' : ''}${ready ? ' dock--ready' : ''}${
        dragging ? ' dock--dragging' : ''
      }`}
      ref={dockRef}
      style={{ '--dock-body-h': `${height}px` } as React.CSSProperties}
    >
      {/* One affordance for one act: pull it to a size, or press it to toggle. */}
      <button
        className="dock-grip"
        aria-expanded={isOpen}
        aria-controls="dock-panel"
        aria-label={isOpen ? 'Collapse' : 'Expand'}
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
      >
        <span />
      </button>

      <div className="dock-head">
        {onBack && (
          <button className="ghost dock-back" onClick={onBack} aria-label="Back">
            ←
          </button>
        )}
        <h1 className="dock-title">{title}</h1>
      </div>

      <div
        className="dock-body"
        id="dock-panel"
        role="tabpanel"
        aria-labelledby={`dock-tab-${tab}`}
        tabIndex={-1}
        ref={bodyRef}
        // Shut means gone: not focusable, not findable, not read out.
        inert={!isOpen}
      >
        {children}
      </div>

      {/* Roving tabindex: one stop for the whole bar, arrows to move within it. */}
      <div
        className="dock-tabs"
        role="tablist"
        aria-label="Sections"
        aria-orientation="horizontal"
        ref={barRef}
        onKeyDown={onBarKey}
        style={
          { '--dock-tab-i': index, '--dock-tab-n': DOCK_TABS.length } as React.CSSProperties
        }
      >
        {DOCK_TABS.map((t) => (
          <button
            key={t.id}
            id={`dock-tab-${t.id}`}
            className="dock-tab"
            role="tab"
            aria-selected={t.id === tab}
            aria-expanded={t.id === tab && isOpen}
            aria-controls="dock-panel"
            tabIndex={t.id === tab ? 0 : -1}
            onClick={() => onTab(t.id)}
          >
            <span className="dock-tab-icon">
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {ICON[t.id]}
              </svg>
              {badges?.[t.id] ? <span className="badge">{badges[t.id]}</span> : null}
            </span>
            {t.label}
          </button>
        ))}
        {/* One marker that moves, rather than five that blink in and out. An
            exact 1/n of the bar, so it travels in whole multiples of itself and
            never has to be measured. */}
        <span className="dock-tab-marker" aria-hidden="true" />
      </div>
    </div>
  )
}
