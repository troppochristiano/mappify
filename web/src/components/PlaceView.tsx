import type { ReactNode } from 'react'
import type { CountryNode, PlaceNode } from '../lib/api'
import { BackIcon } from './icons'

export type Crumb = { label: string; select: PlaceSelection }

export type PlaceSelection =
  | { kind: 'root' }
  | { kind: 'country'; iso: string | null; label: string }
  | { kind: 'place'; qid: string; label: string }
  | { kind: 'city'; city: string; label: string }
  /** Known country, no town — "Somewhere in the United States". */
  | { kind: 'cityless'; iso: string | null; label: string }
  | { kind: 'unknown'; label: string }

/**
 * The trail to a place, derived from the tree rather than remembered.
 *
 * Deriving it is what makes a dot click and a menu walk land in the same place:
 * both set the same URL, and the breadcrumbs are a pure function of that URL, so
 * there is no second source of truth to drift.
 */
export function pathTo(countries: CountryNode[], qid: string): Crumb[] | null {
  for (const c of countries) {
    const walk = (node: PlaceNode, above: Crumb[]): Crumb[] | null => {
      const here = [...above, { label: node.name, select: { kind: 'place' as const, qid: node.qid!, label: node.name } }]
      if (node.qid === qid) return here
      for (const child of node.children) {
        const found = walk(child, here)
        if (found) return found
      }
      return null
    }
    const countryCrumb: Crumb = {
      label: c.name,
      select:
        c.name === 'Unknown'
          ? { kind: 'unknown', label: 'Unknown' }
          : { kind: 'country', iso: c.iso, label: c.name },
    }
    for (const child of c.children) {
      const found = walk(child, [countryCrumb])
      if (found) return found
    }
  }
  return null
}

/** The node at a qid, so its children can be listed. */
export function nodeAt(countries: CountryNode[], qid: string): PlaceNode | null {
  for (const c of countries) {
    const walk = (n: PlaceNode): PlaceNode | null => {
      if (n.qid === qid) return n
      for (const child of n.children) {
        const found = walk(child)
        if (found) return found
      }
      return null
    }
    for (const child of c.children) {
      const found = walk(child)
      if (found) return found
    }
  }
  return null
}

/**
 * One panel for browsing and for a selected place — the same thing seen from
 * either a dot click or the menu. Shows where you are, what is nested inside,
 * and who is from here.
 */
export function PlaceView({
  crumbs,
  nested,
  onNavigate,
  onHoverRow,
  subtitle,
  actions,
  body,
}: {
  crumbs: Crumb[]
  nested: { key: string; label: string; count: number; select: PlaceSelection; drillable: boolean }[]
  onNavigate: (s: PlaceSelection) => void
  /** Hovering a row lights the same dots as hovering them on the globe. */
  onHoverRow?: (s: PlaceSelection | null) => void
  subtitle?: ReactNode
  actions?: ReactNode
  body?: ReactNode
}) {
  // The last crumb is where you are; the one before it is what "back" means.
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2] : null

  return (
    <div className="place-view">
      {/* Back sits with the trail it acts on. The dock head above says where you
          are and holds the only other back there is, which leaves a pushed view
          rather than climbing the tree. At the root there is nothing to go back
          to. */}
      <nav className="crumbs" aria-label="Place trail">
        {parent && (
          <button
            className="crumb crumb-back"
            onClick={() => onNavigate(parent.select)}
            aria-label={`Back to ${parent.label}`}
          >
            <BackIcon />
          </button>
        )}
        {crumbs.map((c, i) => (
          <span key={i}>
            {i > 0 && <span className="crumb-sep">›</span>}
            <button
              className="crumb"
              aria-current={i === crumbs.length - 1}
              onClick={() => onNavigate(c.select)}
            >
              {c.label}
            </button>
          </span>
        ))}
      </nav>

      {subtitle && <p className="panel-sub">{subtitle}</p>}
      {actions}

      {nested.length > 0 && (
        <>
          <h2 style={{ marginTop: 4 }}>Inside</h2>
          <ul className="menu-list">
            {nested.map((r) => (
              <li key={r.key}>
                <button
                  className="menu-row"
                  onClick={() => onNavigate(r.select)}
                  onMouseEnter={() => onHoverRow?.(r.select)}
                  onMouseLeave={() => onHoverRow?.(null)}
                  onFocus={() => onHoverRow?.(r.select)}
                  onBlur={() => onHoverRow?.(null)}
                >
                  <span className="menu-name">{r.label}</span>
                  <span className="menu-count">{r.count}</span>
                  {r.drillable && <span className="menu-more" aria-hidden="true">›</span>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {body}
    </div>
  )
}
