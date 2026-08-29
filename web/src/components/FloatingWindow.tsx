import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

export type Rect = { x: number; y: number; w: number; h: number }
export type Size = { width: number; height: number }

const MIN_W = 420
const MIN_H = 300
const HEAD_H = 44 // keep at least the title bar reachable when clamping

/**
 * A draggable, resizable, closable window that lives over the globe.
 *
 * Generic on purpose: the search, place and artist panels can move into one of
 * these later without rewriting the interaction. Pointer handling follows the
 * same capture pattern as globe rotation in Globe.tsx.
 */
export function FloatingWindow({
  title,
  subtitle,
  onClose,
  storageKey,
  defaultRect,
  onBodySize,
  children,
}: {
  title: ReactNode
  subtitle?: ReactNode
  onClose: () => void
  storageKey: string
  defaultRect: Rect
  /**
   * Reports the body's size whenever it changes. Deliberately not a
   * ResizeObserver: the window already knows when it resized, and observers are
   * throttled to nothing in a background or non-compositing tab — the same trap
   * that left the globe blank.
   */
  onBodySize?: (size: Size) => void
  children: ReactNode
}) {
  const [rect, setRect] = useState<Rect>(() => clamp(load(storageKey) ?? defaultRect))
  const drag = useRef<{ mode: 'move' | 'resize'; x: number; y: number; rect: Rect } | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const lastSize = useRef<Size>({ width: 0, height: 0 })

  // Measured after every render, which is deterministic and needs no observer:
  // the window is the thing doing the resizing.
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el || !onBodySize) return
    const width = el.clientWidth
    const height = el.clientHeight
    if (!width || !height) return
    if (lastSize.current.width === width && lastSize.current.height === height) return
    lastSize.current = { width, height }
    onBodySize({ width, height })
  })

  // Persist whatever the user settled on.
  useEffect(() => {
    // Never persist a rect derived from an unmeasurable viewport.
    if (window.innerWidth < MIN_W || window.innerHeight < MIN_H) return
    try {
      localStorage.setItem(storageKey, JSON.stringify(rect))
    } catch {
      /* private mode, quota — the window still works, it just will not persist */
    }
  }, [rect, storageKey])

  // A window restored from storage, or left near an edge, must not end up
  // somewhere it cannot be grabbed back from when the viewport shrinks.
  useEffect(() => {
    const onResize = () => setRect((r) => clamp(r))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const onPointerDown = useCallback(
    (mode: 'move' | 'resize') => (e: React.PointerEvent<HTMLElement>) => {
      // The close button sits inside the drag surface, and this handler used to
      // swallow them both: cancelling `pointerdown` suppresses the compatibility
      // mouse events that follow it, `click` included, so their onClick never
      // ran. The header stays draggable everywhere that is not a control.
      if ((e.target as HTMLElement).closest('button')) return
      e.preventDefault()
      // Record the gesture before capturing. setPointerCapture throws for a
      // pointer id that is not currently active, and doing it first meant one
      // throw silently swallowed the whole drag.
      drag.current = { mode, x: e.clientX, y: e.clientY, rect }
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* capture is an optimisation: it keeps events coming if the pointer
           leaves the element. The drag still works through the element itself. */
      }
    },
    [rect]
  )

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    setRect(
      clamp(
        d.mode === 'move'
          ? { ...d.rect, x: d.rect.x + dx, y: d.rect.y + dy }
          : { ...d.rect, w: d.rect.w + dx, h: d.rect.h + dy }
      )
    )
  }, [])

  const endDrag = useCallback((e: React.PointerEvent<HTMLElement>) => {
    drag.current = null
    try {
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    } catch {
      /* nothing to release */
    }
  }, [])

  // No maximize. It was a button beside the close, and taking the button away
  // while keeping the state would have left it reachable only by double-clicking
  // the header — with the resize grip hidden in that state and nothing on screen
  // to get back out of it. Every way to size this window is now visible: drag
  // the head, pull the corner, or close it.
  const style: React.CSSProperties = { left: rect.x, top: rect.y, width: rect.w, height: rect.h }

  return (
    <div className="win" style={style} role="dialog" aria-label={typeof title === 'string' ? title : undefined}>
      <div
        className="win-head"
        onPointerDown={onPointerDown('move')}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <h2 className="win-title">{title}</h2>
        <div className="win-actions">
          <button className="win-btn" onClick={onClose} aria-label="Close window" title="Close">
            ×
          </button>
        </div>
      </div>

      {subtitle && <div className="win-sub">{subtitle}</div>}

      <div className="win-body" ref={bodyRef}>{children}</div>

      <div
        className="win-grip"
        onPointerDown={onPointerDown('resize')}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        aria-hidden="true"
      />
    </div>
  )
}

function clamp(r: Rect): Rect {
  const vw = window.innerWidth
  const vh = window.innerHeight
  // A viewport can measure zero before layout, or in a pane that is not being
  // rendered. Clamping against that collapses the window to its minimum in the
  // top-left corner — and worse, persists it. Leave the rect alone instead.
  if (vw < MIN_W || vh < MIN_H) return r
  const w = Math.max(MIN_W, Math.min(r.w, vw - 24))
  const h = Math.max(MIN_H, Math.min(r.h, vh - 24))
  return {
    w,
    h,
    // Left/top may go slightly negative-ish at the edges, but the title bar
    // always stays on screen so the window can be dragged back.
    x: Math.max(-w + 120, Math.min(r.x, vw - 120)),
    y: Math.max(0, Math.min(r.y, vh - HEAD_H)),
  }
}

function load(key: string): Rect | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return typeof parsed?.x === 'number' && typeof parsed?.w === 'number' ? parsed : null
  } catch {
    return null
  }
}
