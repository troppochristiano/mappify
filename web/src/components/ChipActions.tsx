import type { ChipMode } from '../lib/filters'

/**
 * Strokes, not characters.
 *
 * `+` and `−` are U+002B and U+2212: different advance widths, different ink
 * heights, and both drawn on the mathematical axis rather than the middle of
 * the em box. Centring them puts the *line box* in the middle of the circle,
 * which is not the same thing as putting the glyph there — so neither sat true,
 * and the two did not even agree with each other. Two paths on one grid do.
 */
function Glyph({ plus }: { plus: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      width="12"
      height="12"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    >
      <path d="M2.4 6h7.2" />
      {plus && <path d="M6 2.4v7.2" />}
    </svg>
  )
}

/**
 * The + / − pair that turns a row into a filter.
 *
 * Shared rather than written twice: a search result and a browsed row are the
 * same offer — narrow to this, or rule it out — and the moment the two are
 * separate markup they start disagreeing about which one is lit, what the
 * screen reader is told, and which glyph means what.
 *
 * `mode` is how this target is *currently* chipped, not what the buttons do:
 * it is what lights the corresponding button, so a row you have already picked
 * says so wherever you meet it again.
 *
 * Each button is a toggle, which is what it has always claimed to be — it
 * carries `aria-pressed` and lights up. Pressing the lit one clears the chip
 * rather than setting the mode it is already in, which used to be a no-op that
 * still rewrote the URL.
 */
export function ChipActions({
  label,
  mode,
  onPick,
  onClear,
}: {
  label: string
  mode: ChipMode | undefined
  onPick: (mode: ChipMode) => void
  onClear: () => void
}) {
  return (
    <span className="search-acts">
      <button
        type="button"
        className={`chip-act${mode === 'include' ? ' on' : ''}`}
        title={mode === 'include' ? `Stop narrowing to ${label}` : `Narrow to ${label}`}
        aria-label={mode === 'include' ? `Stop narrowing to ${label}` : `Narrow to ${label}`}
        aria-pressed={mode === 'include'}
        onClick={() => (mode === 'include' ? onClear() : onPick('include'))}
      >
        <Glyph plus />
      </button>
      <button
        type="button"
        className={`chip-act${mode === 'exclude' ? ' on' : ''}`}
        title={mode === 'exclude' ? `Stop ruling out ${label}` : `Rule out ${label}`}
        aria-label={mode === 'exclude' ? `Stop ruling out ${label}` : `Rule out ${label}`}
        aria-pressed={mode === 'exclude'}
        onClick={() => (mode === 'exclude' ? onClear() : onPick('exclude'))}
      >
        <Glyph plus={false} />
      </button>
    </span>
  )
}
