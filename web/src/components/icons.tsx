/**
 * The three icons that used to be typed characters.
 *
 * ▶, i and ← were text, and text cannot be centred in a button. `align-items:
 * center` centres the *line box* — ascender to descender — while the eye reads
 * the ink, and the two differ by whatever the font reserves below the baseline
 * for glyphs that never go there. Measured in this app's stack that was 0.5px
 * low in the round buttons and 1px low in the dock's back button. ▶ was worse
 * still: its ink is 11px wide inside an 8.6px advance, so the character
 * overflows the box that gets centred.
 *
 * None of those numbers is a constant to nudge by — they are properties of
 * whichever font the fallback list happens to land on, and change per machine.
 * A viewBox has no such thing: the drawing is centred in its own box, the box is
 * the button, and it is the same everywhere.
 *
 * Same 24 geometry as the dock's tab icons, for the reason given there. The two
 * marks that live in the round buttons are filled rather than stroked, because
 * at 13px a 1.6 stroke is most of the shape; ← is stroked, since it sits in the
 * dock head beside the tabs and belongs to them.
 */

/**
 * Centred on its area, not its bounding box.
 *
 * A triangle pointing right has its weight behind the point, so a box-centred
 * one reads as sitting left — the reason play buttons are drawn nudged over.
 * The three vertices average to exactly (12, 12), which puts the centroid on the
 * centre of the circle and the point slightly past it.
 */
export function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M8.5 5.5 19 12 8.5 18.5Z" />
    </svg>
  )
}

/** A dot and a stem, spaced so the ink spans 5.3 to 18.7 — centred on 12. */
export function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <circle cx="12" cy="7" r="1.7" />
      <rect x="10.6" y="10.5" width="2.8" height="8.2" rx="1.4" />
    </svg>
  )
}

/** Shaft and head both centred on 12, so the arrow sits on both axes. */
export function BackIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 12H4" />
      <path d="m10 6-6 6 6 6" />
    </svg>
  )
}
