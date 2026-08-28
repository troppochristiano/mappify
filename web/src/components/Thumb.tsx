/**
 * The little square beside a name.
 *
 * Always the same box whether or not there is a picture for it, and whether or
 * not that picture has arrived: a list of two hundred rows that sized itself to
 * the covers would reflow line by line as they loaded, and one that showed the
 * box only for the rows that have art would leave every name in a group sitting
 * at a different indent from its neighbours.
 *
 * Decoration, not information — the name beside it already says what this is,
 * so there is no alt text for a screen reader to read out twice. `lazy` is the
 * point of the whole thing: a place can list two hundred artists, and only the
 * handful actually scrolled to should ever reach the network.
 */
export function Thumb({ src }: { src: string | null | undefined }) {
  if (!src) return <span className="thumb" aria-hidden="true" />
  return <img className="thumb" src={src} alt="" loading="lazy" decoding="async" />
}
