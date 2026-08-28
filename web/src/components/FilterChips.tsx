import { useLayoutEffect, useRef, useState } from 'react'
import type { Chip } from '../lib/filters'
import { chipTarget } from '../lib/filters'

/**
 * The filters currently narrowing the globe, as removable pills.
 *
 * A chip has three states, not two — included, excluded, gone — so it is not an
 * `aria-pressed` toggle. Clicking the body flips between the first two; the ✕
 * removes it. The mode is in the accessible name rather than only in the colour,
 * because "not Italy" and "Italy" are opposite meanings and must not depend on
 * being able to tell green from outlined.
 */

const KIND_LABEL: Record<Chip['kind'], string> = {
  artist: 'artist',
  playlist: 'playlist',
  place: 'place',
}

/**
 * The rendered height of an element, tracked.
 *
 * Measured rather than left to CSS because the row of chips changes height in
 * two different ways and only one of them is a change CSS can see. Appearing at
 * all is 0 to auto, which `interpolate-size` could animate; a third chip
 * wrapping onto a second line is auto to auto, where the computed value never
 * changes and no transition fires. A number covers both, and covers them the
 * same way in every browser rather than only in a recent Chromium.
 */
function useMeasuredHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [height, setHeight] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setHeight(el.offsetHeight)
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
    // Once, not per render: the element it watches outlives every re-render, and
    // the observer already reports the only thing this is waiting for.
  }, [])
  return [ref, height] as const
}

type Props = {
  chips: Chip[]
  onToggle: (target: string) => void
  onRemove: (target: string) => void
  onClear: () => void
  /**
   * The chips the server did not apply, because there is a cap per kind.
   *
   * Marked rather than merely counted: "four of these are ignored" without
   * saying which one leaves you deleting chips one at a time to find out. They
   * are shown as not-in-effect, never as broken — a dropped chip is valid and
   * correctly spelled, and one that looks damaged makes people think they
   * mistyped something.
   *
   * Must arrive already reconciled with `chips` — see the note at the call site.
   */
  dropped?: ReadonlySet<string>
}

export function FilterChips({ chips, onToggle, onRemove, onClear, dropped }: Props) {
  const [inner, height] = useMeasuredHeight<HTMLDivElement>()

  // A link that arrives already filtered should arrive with its chips, not play
  // them opening. Same reason the dock waits a frame before it will animate.
  const [ready, setReady] = useState(false)
  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => setReady(true))
    return () => cancelAnimationFrame(id)
  }, [])

  return (
    <div
      className={`chips-slot${ready ? ' chips-slot--ready' : ''}`}
      style={{ height }}
      // Empty is nothing at all, not an empty list: with no chips there is no
      // group here for a screen reader to land in and find zero of.
      aria-hidden={chips.length === 0 || undefined}
    >
      <div className="chips" ref={inner}>
        {chips.map((c) => {
          const target = chipTarget(c)
          const excluded = c.mode === 'exclude'
          const notApplied = dropped?.has(target) ?? false
          return (
            <span
              // Keyed by target, so adding one does not remount the rest — which
              // is what keeps the entrance animation on the chip you just made
              // instead of on every chip you already had.
              key={target}
              className="chip"
              data-mode={c.mode}
              data-applied={notApplied ? 'no' : undefined}
            >
              <button
                type="button"
                className="chip-body"
                onClick={() => onToggle(target)}
                title={
                  notApplied
                    ? `Not in effect — too many ${KIND_LABEL[c.kind]} filters`
                    : excluded
                      ? 'Excluded — click to include'
                      : 'Included — click to exclude'
                }
                // The state is spelled out, not left to the colour: this is the
                // only one of the three that a screen reader could otherwise miss.
                aria-label={`${KIND_LABEL[c.kind]} ${c.label}, ${
                  excluded ? 'excluded' : 'included'
                }${
                  notApplied ? `, not applied: over the limit for ${KIND_LABEL[c.kind]} filters` : ''
                }. Activate to ${excluded ? 'include' : 'exclude'}.`}
              >
                <span className="chip-mark" aria-hidden="true">
                  {excluded ? '−' : '+'}
                </span>
                <span className="chip-kind">{KIND_LABEL[c.kind]}</span>
                <span className="chip-name">{c.label}</span>
              </button>
              <button
                type="button"
                className="chip-x"
                onClick={() => onRemove(target)}
                aria-label={`Remove ${c.label}`}
              >
                ✕
              </button>
            </span>
          )
        })}
        {chips.length > 1 && (
          <button type="button" className="linkish chip-clear" onClick={onClear}>
            clear all
          </button>
        )}
      </div>
    </div>
  )
}
