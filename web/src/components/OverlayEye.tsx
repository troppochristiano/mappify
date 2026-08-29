/**
 * Show or hide an imported library's rings on the globe.
 *
 * One component rather than three, because the same act is reachable from three
 * places — a row in the compare list, the comparison itself, and the places tab
 * over the map — and a toggle that looked different in each would read as three
 * different settings.
 *
 * The eye carries the library's own colour while it is showing, so the control
 * says *whose* rings it is about without a swatch beside it, and goes to the dim
 * grey the rest of the app uses for "off" when it is not. An eye alone still
 * does not say whose places or where, though, which is what the label is for —
 * it is the accessible name, not decoration.
 */
export function OverlayEye({
  visible,
  colour,
  label,
  onClick,
}: {
  visible: boolean
  colour: string
  /** Spelled out: "Hide Bo's places on the globe". */
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="eye"
      aria-pressed={visible}
      onClick={onClick}
      title={label}
      aria-label={label}
      style={visible ? { color: colour } : undefined}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        {/* The same 24 box and 1.6 stroke as the dock's icons, so this weighs the
            same as everything else drawn in this app. */}
        <path
          d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="12" cy="12" r="3.1" />
        {/* Struck through rather than swapped for a different shape: the two
            states have to be the same object, or the change reads as a different
            control appearing rather than as this one turning off. */}
        {!visible && <path d="M4 20 20 4" strokeLinecap="round" />}
      </svg>
    </button>
  )
}
