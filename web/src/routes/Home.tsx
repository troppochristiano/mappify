import { useState, useEffect, useDeferredValue, useMemo, useCallback, useRef } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { api, type Artist, type PlaceLink, type PlaceTrack } from '../lib/api'
import {
  Globe,
  DOT_MODES,
  LINK_MODES,
  rampAt,
  type DotMode,
  type LinkMode,
  type FlyTarget,
} from '../components/Globe'
import { SpotifyPlayer, type NowPlaying } from '../components/SpotifyPlayer'
import { PlaceView, pathTo, nodeAt, type Crumb, type PlaceSelection } from '../components/PlaceView'
import { ArtistRow } from '../components/ArtistRow'
import { ArtistDetail } from '../components/ArtistDetail'
import { SetupPanel } from '../components/SetupPanel'
import { PlaylistBuilder } from '../components/PlaylistBuilder'
import { TunedReadout } from '../components/TunedReadout'
import { SourceFilter } from '../components/SourceFilter'

/**
 * The closest the globe will pull back to when you pick a single place.
 *
 * A city is a point, not a region, so this is much tighter than the framing a
 * country gets. It is a floor rather than a target: fly at least this close if
 * you are further out, and if you are already closer, hold the zoom and just
 * centre the place.
 */
const PLACE_ZOOM = 6

/**
 * How much of a click's zoom a hover holds back, in zoom levels.
 *
 * Enough to see where you are being shown, short of the commitment a click
 * makes — so skimming a list reads as a tour rather than as a series of
 * decisions you have to undo. This was a 0.55 multiplier when the camera was
 * described by a projection scale; zoom levels are the log of that, so the same
 * pull-back is log2(0.55) ≈ 0.86 of a level.
 */
const HOVER_ZOOM_BACK = 0.86

/**
 * A stable empty array for the links prop.
 *
 * `?? []` would be a new array on every render, and a fresh identity makes the
 * globe re-densify and re-upload every arc — so the literal is hoisted.
 */
const EMPTY_LINKS: PlaceLink[] = []

/**
 * The globe is the app. Search sits on top of it and filters the dots
 * themselves rather than opening a separate page.
 */
export function Home() {
  const [params, setParams] = useSearchParams()
  const selectedQid = params.get('place')
  const [text, setText] = useState('')
  const q = useDeferredValue(text)
  // Panels are one exclusive group: opening browse closes library and vice
  // versa, so they behave as a toggle rather than stacking on top of each other.
  const [panel, setPanel] = useState<'none' | 'browse' | 'library'>('none')
  const showBrowse = panel === 'browse'
  const showSetup = panel === 'library'
  const [building, setBuilding] = useState(false)

  // Which encoding reads better is a judgement call, so it is a switch rather
  // than a decision baked in — and it survives reloads so the two can be
  // compared on the same view.
  const [linkMode, setLinkMode] = useState<LinkMode>(
    () => (localStorage.getItem('mappify.linkMode') as LinkMode) || 'nesting'
  )
  useEffect(() => {
    localStorage.setItem('mappify.linkMode', linkMode)
  }, [linkMode])

  const [dotMode, setDotMode] = useState<DotMode>(
    () => (localStorage.getItem('mappify.dotMode') as DotMode) || 'size'
  )
  useEffect(() => {
    localStorage.setItem('mappify.dotMode', dotMode)
  }, [dotMode])

  // Closing from the toolbar button is the same act as closing from the ✕, so
  // it undoes the same things — including the framing the globe was flown to.
  const openBrowse = () => {
    if (panel === 'browse') {
      close()
      setPanel('none')
    } else setPanel('browse')
  }
  /** Artist whose details are open in the panel — never a route change. */
  const [infoId, setInfoId] = useState<string | null>(null)

  // Which part of the library the whole view is showing. In the URL so a
  // filtered globe is a link you can send someone.
  const sourceId = params.get('source')
  const setSourceId = (id: string | null) => {
    const next = new URLSearchParams(params)
    if (id) next.set('source', id)
    else next.delete('source')
    setParams(next, { replace: true })
  }

  // keepPreviousData on both: an import refreshes these every ~25 seconds as it
  // resolves more artists, and without it the globe would blink empty each time.
  const map = useQuery({
    queryKey: ['map', sourceId],
    queryFn: () => api.map(sourceId),
    placeholderData: keepPreviousData,
  })
  // Always loaded, not just while browsing: a dot click needs the tree to work
  // out its ancestry for the breadcrumbs.
  const tree = useQuery({
    queryKey: ['tree', sourceId],
    queryFn: () => api.tree(sourceId),
    placeholderData: keepPreviousData,
  })
  // Both relations arrive together; the toggle only picks which to draw.
  const links = useQuery({ queryKey: ['links'], queryFn: api.links })
  const shownLinks = useMemo(() => {
    if (linkMode === 'nesting') return links.data?.nesting ?? EMPTY_LINKS
    if (linkMode === 'collabs') return links.data?.collab ?? EMPTY_LINKS
    return EMPTY_LINKS
  }, [linkMode, links.data])

  // Search drives the lit dots, so the filter is visible on the globe itself.
  const matches = useQuery({
    queryKey: ['artists', 'globe', q, sourceId],
    queryFn: () => api.artists({ q, source: sourceId, limit: 200 }),
    enabled: q.trim().length > 0,
  })

  const litQids = useMemo(() => {
    if (!q.trim() || !matches.data) return null
    return new Set(matches.data.items.map((a) => a.place_qid).filter(Boolean) as string[])
  }, [q, matches.data])

  const selected = map.data?.points.find((p) => p.qid === selectedQid) ?? null

  // A selection is not always a dot: it can be a whole country, a city the map
  // has no coordinates for, or the Unknown bucket. All four open the same panel.
  const isoFilter = params.get('iso')
  const cityFilter = params.get('city')
  const unknownFilter = params.get('unknown') === '1'
  const citylessFilter = params.get('cityless') === '1'
  const hasFilter = Boolean(
    selectedQid || isoFilter || cityFilter || unknownFilter || citylessFilter
  )
  const regionName = (iso: string) =>
    new Intl.DisplayNames(['en'], { type: 'region' }).of(iso) ?? iso
  const filterLabel =
    selected?.name ??
    params.get('label') ??
    cityFilter ??
    (citylessFilter ? (isoFilter ? 'City unknown' : 'No known origin') : null) ??
    (unknownFilter ? 'Unknown origin' : null) ??
    (isoFilter ? regionName(isoFilter) : null) ??
    'Selection'

  const artists = useQuery({
    queryKey: ['artists', 'filter', selectedQid, isoFilter, cityFilter, unknownFilter, citylessFilter, sourceId],
    queryFn: () =>
      api.artists({
        placeQid: selectedQid ?? undefined,
        iso: isoFilter ?? undefined,
        city: cityFilter ?? undefined,
        unknown: unknownFilter || undefined,
        cityless: citylessFilter || undefined,
        source: sourceId,
        limit: 200,
      }),
    enabled: hasFilter,
  })

  const track = useQuery({
    queryKey: ['place-track', selectedQid],
    queryFn: () => api.placeTrack(selectedQid!),
    enabled: Boolean(selectedQid),
  })

  // A track picked by hand (an artist or a song in the results) wins over the
  // place's random pick, until the place changes and re-tunes.
  const [manual, setManual] = useState<PlaceTrack | null>(null)

  const source = manual ?? track.data ?? null
  const nowPlaying: NowPlaying = source?.uri
    ? {
        uri: source.uri,
        name: source.name,
        artist: source.artist,
        place: (manual ? source.city : selected?.name ?? source.city) ?? '',
      }
    : null

  const playArtist = async (a: Artist) => {
    const t = await api.artistTrack(a.spotify_id)
    if (t?.uri) setManual(t)
  }

  // Tuning to a different place hands playback back to that place. Driven off
  // the selection itself rather than the click handler, so browser back/forward
  // and deep links behave the same as clicking a dot.
  useEffect(() => {
    setManual(null)
    setInfoId(null)
  }, [selectedQid])

  const [flyTo, setFlyTo] = useState<FlyTarget | null>(null)
  /** Whatever the cursor is over on the globe — never a selection. */
  // The hovered place lives in TunedReadout, not here — see the note there. The
  // route only holds the wire to it, so onHover can be an identity that never
  // changes and never re-renders anything above the readout itself.
  const tunedSetter = useRef<((qid: string | null) => void) | null>(null)
  const registerTuned = useCallback((set: ((qid: string | null) => void) | null) => {
    tunedSetter.current = set
  }, [])
  const onHover = useCallback((qid: string | null) => tunedSetter.current?.(qid), [])
  /** Whatever the cursor is over in the place menu, lit on the globe. */
  const [menuHover, setMenuHover] = useState<PlaceSelection | null>(null)

  /**
   * Leaving the places panel drops the selection and nothing else.
   *
   * Deliberately does not touch the camera: where you have flown to is your
   * business, and yanking the globe back out to the whole world every time a
   * panel closes throws away the view you went to the trouble of finding. What
   * closing restores is the *unselected* state — no place singled out, every
   * label back in play.
   */
  const close = () => {
    const next = new URLSearchParams(params)
    for (const k of ['place', 'iso', 'city', 'unknown', 'cityless', 'label']) next.delete(k)
    // Hovering a row spotlights its dots and quietens every other label. React
    // does not fire mouseleave when an element unmounts, so closing the panel
    // with the pointer resting on a row left that spotlight on with no row left
    // to leave — the globe stayed dimmed and half its names stayed hidden.
    setMenuHover(null)
    setParams(next, { replace: true })
  }

  /**
   * Where to point the globe for a country, and how close.
   *
   * A country has no dot of its own, so it is centred on the track-weighted
   * centroid of the places inside it — that aims at where the music actually is
   * rather than the middle of the landmass. The zoom is left to the camera,
   * which is asked what would fit the box those places occupy: the old
   * spread-to-scale formula had to be retuned by hand whenever the window
   * changed shape, and this cannot fall out of step with the viewport.
   */
  const countryFrame = useCallback(
    (iso: string) => {
      const pts = (map.data?.points ?? []).filter((p) => p.country_iso === iso)
      if (!pts.length) return null
      const w = pts.reduce((n, p) => n + p.tracks, 0) || pts.length
      const lat = pts.reduce((n, p) => n + p.lat * p.tracks, 0) / w
      const lon = pts.reduce((n, p) => n + p.lon * p.tracks, 0) / w
      const lats = pts.map((p) => p.lat)
      const lons = pts.map((p) => p.lon)
      // A country holding a single place has no box to fit, so it is given a
      // little room around the point rather than a zero-width one.
      const pad = pts.length > 1 ? 0 : 0.5
      const bounds: [[number, number], [number, number]] = [
        [Math.min(...lons) - pad, Math.min(...lats) - pad],
        [Math.max(...lons) + pad, Math.max(...lats) + pad],
      ]
      return { lat, lon, bounds }
    },
    [map.data]
  )

  /**
   * Hovering a menu row lights the matching dots. A country covers many dots,
   * so this is a set rather than one id — hovering "Italy" shows you the whole
   * spread at once.
   */
  const highlight = useMemo(() => {
    if (!menuHover) return null
    if (menuHover.kind === 'place') return new Set([menuHover.qid])
    if (menuHover.kind === 'country' && menuHover.iso) {
      return new Set(
        (map.data?.points ?? []).filter((p) => p.country_iso === menuHover.iso).map((p) => p.qid)
      )
    }
    return null
  }, [menuHover, map.data])

  /**
   * Hovering a row also turns the globe to it — but only after a short pause.
   * Without the delay, running the cursor down the country list would spin the
   * globe once per row.
   *
   * Hover moves in as well as around, but only as a floor and never as far as a
   * click: skimming rows should show you the place, not park you in it. Because
   * it is a floor, running down a list never yanks you back out — each row you
   * pass either brings you closer or leaves the zoom alone.
   */
  useEffect(() => {
    if (!menuHover) return
    const timer = window.setTimeout(() => {
      if (menuHover.kind === 'country' && menuHover.iso) {
        const frame = countryFrame(menuHover.iso)
        if (frame) {
          setFlyTo({
            ...frame,
            zoomBack: HOVER_ZOOM_BACK,
            key: `hover:${menuHover.iso}`,
          })
        }
      } else if (menuHover.kind === 'place') {
        const point = map.data?.points.find((p) => p.qid === menuHover.qid)
        if (point) {
          setFlyTo({
            lat: point.lat,
            lon: point.lon,
            zoomAtLeast: PLACE_ZOOM - HOVER_ZOOM_BACK,
            key: `hover:${menuHover.qid}`,
          })
        }
      }
    }, 220)
    return () => window.clearTimeout(timer)
  }, [menuHover, countryFrame, map.data])

  const infoArtist =
    matches.data?.items.find((a) => a.spotify_id === infoId) ??
    artists.data?.items.find((a) => a.spotify_id === infoId) ??
    null

  /**
   * Every level selects something, including Unknown — an artist with no known
   * origin is still a row you should be able to open. The URL is the single
   * source of truth, so a dot click and a menu click are the same event.
   */
  const onNavigate = (s: PlaceSelection) => {
    const next = new URLSearchParams(params)
    for (const k of ['place', 'iso', 'city', 'unknown', 'cityless']) next.delete(k)

    if (s.kind === 'place') {
      const point = map.data?.points.find((p) => p.qid === s.qid)
      // A floor, not a framing: if you have already zoomed past this, picking a
      // dot just centres it and leaves your zoom alone.
      if (point) setFlyTo({ lat: point.lat, lon: point.lon, zoomAtLeast: PLACE_ZOOM, key: s.qid })
      next.set('place', s.qid)
    } else if (s.kind === 'country' && s.iso) {
      const frame = countryFrame(s.iso)
      if (frame) setFlyTo({ ...frame, key: s.iso })
      next.set('iso', s.iso)
    }
    else if (s.kind === 'city') next.set('city', s.city)
    else if (s.kind === 'cityless') {
      // Carries the country as well, so the trail can lead back up to it.
      next.set('cityless', '1')
      if (s.iso) next.set('iso', s.iso)
    } else if (s.kind === 'unknown') next.set('unknown', '1')
    // 'root' clears everything, which the deletes above already did.
    // Same reason as in close(): the row you clicked is about to be replaced by
    // the level below it, and an unmounted row never fires mouseleave.
    setMenuHover(null)
    setParams(next, { replace: true })
    setPanel('browse')
  }

  /**
   * Clicking a dot is the same navigation as clicking its row, so it is the same
   * call. The two used to be separate: the menu flew the globe to the place and
   * zoomed in, while a dot click only rewrote the URL and left the camera where
   * it was — so the two routes to the same place behaved differently. Going
   * through onNavigate means they cannot drift apart again.
   */
  const select = (qid: string) => {
    const point = map.data?.points.find((p) => p.qid === qid)
    onNavigate({ kind: 'place', qid, label: point?.name ?? 'Place' })
  }

  const countries = tree.data?.countries ?? []

  /** Where you are, worked out from the URL rather than remembered separately. */
  const crumbs: Crumb[] = useMemo(() => {
    const root: Crumb = { label: 'World', select: { kind: 'root' } }
    if (selectedQid) {
      const found = pathTo(countries, selectedQid)
      if (found) return [root, ...found]
      return [root, { label: selected?.name ?? 'Place', select: { kind: 'place', qid: selectedQid, label: selected?.name ?? 'Place' } }]
    }
    // Checked before the country, because a cityless selection carries an iso of
    // its own and would otherwise read as "the whole country".
    if (citylessFilter) {
      const c = countries.find((x) => x.iso === isoFilter)
      const country: Crumb[] = isoFilter
        ? [{ label: c?.name ?? isoFilter, select: { kind: 'country', iso: isoFilter, label: c?.name ?? isoFilter } }]
        : []
      return [root, ...country, { label: filterLabel, select: { kind: 'cityless', iso: isoFilter, label: filterLabel } }]
    }
    if (isoFilter) {
      const c = countries.find((x) => x.iso === isoFilter)
      return [root, { label: c?.name ?? isoFilter, select: { kind: 'country', iso: isoFilter, label: c?.name ?? isoFilter } }]
    }
    if (unknownFilter) return [root, { label: 'Unknown', select: { kind: 'unknown', label: 'Unknown' } }]
    if (cityFilter) return [root, { label: cityFilter, select: { kind: 'city', city: cityFilter, label: cityFilter } }]
    return [root]
  }, [countries, selectedQid, isoFilter, cityFilter, unknownFilter, citylessFilter, filterLabel, selected?.name])

  /** What sits inside the current level. */
  const nested = useMemo(() => {
    const toRow = (n: {
      qid: string | null
      name: string
      totalTracks: number
      children: unknown[]
      city?: string | null
      iso?: string | null
      cityless?: boolean
    }) => ({
      key: n.qid ?? (n.cityless ? `cityless:${n.iso ?? 'ZZ'}` : `city:${n.name}`),
      label: n.name,
      count: n.totalTracks,
      drillable: n.children.length > 0,
      // A row selects by what the server says it is, never by its label — that
      // is what left "Unknown city" opening onto nothing.
      select: (n.qid
        ? { kind: 'place', qid: n.qid, label: n.name }
        : n.cityless
          ? { kind: 'cityless', iso: n.iso ?? null, label: n.name }
          : { kind: 'city', city: n.city ?? n.name, label: n.name }) as PlaceSelection,
    })
    if (selectedQid) return (nodeAt(countries, selectedQid)?.children ?? []).map(toRow)
    // Before the iso branch: a cityless selection is a leaf, not a country.
    if (unknownFilter || cityFilter || citylessFilter) return []
    if (isoFilter) return (countries.find((c) => c.iso === isoFilter)?.children ?? []).map(toRow)
    return countries.map((c) => ({
      key: c.iso ?? 'ZZ',
      label: c.name,
      count: c.tracks,
      drillable: c.children.length > 0,
      select: (c.name === 'Unknown'
        ? { kind: 'unknown', label: 'Unknown' }
        : { kind: 'country', iso: c.iso, label: c.name }) as PlaceSelection,
    }))
  }, [countries, selectedQid, isoFilter, cityFilter, unknownFilter, citylessFilter])

  return (
    <div className="globe-route">
      {map.data && (
        <Globe
          points={map.data.points}
          litQids={litQids}
          selectedQid={selectedQid}
          onSelect={select}
          onHover={onHover}
          flyTo={flyTo}
          dotMode={dotMode}
          links={shownLinks}
          linkMode={linkMode}
          highlight={highlight}
        />
      )}

      {/* Colour needs a key to be readable at all; size does not. */}
      {dotMode === 'colour' && map.data && (
        <div className="legend">
          <span>1</span>
          <i
            style={{
              background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1]
                .map((t) => `rgb(${rampAt(t).join(',')})`)
                .join(', ')})`,
            }}
          />
          <span>{Math.max(...map.data.points.map((p) => p.tracks))}</span>
          <em>tracks</em>
        </div>
      )}

      {/* No reticle: dots are clicked directly and hover shows a pointer, so a
          fixed crosshair was decoration that also blocked the view. Hovering
          still names the place under the cursor. */}
      {/* Shown even with a place selected: hovering to identify neighbouring
          dots is exactly what you do while a panel is open. */}
      {map.data && (
        <TunedReadout
          points={map.data.points}
          selectedQid={selectedQid}
          register={registerTuned}
        />
      )}

      <div className="globe-search">
        <input
          type="search"
          value={text}
          placeholder="search artists and places"
          onChange={(e) => setText(e.target.value)}
          autoComplete="off"
        />
        <div className="seg" role="group" aria-label="Dot encoding">
          {DOT_MODES.map((m) => (
            <button key={m.id} aria-pressed={dotMode === m.id} onClick={() => setDotMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Strings between places">
          {LINK_MODES.map((m) => (
            <button key={m.id} aria-pressed={linkMode === m.id} onClick={() => setLinkMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <SourceFilter value={sourceId} onChange={setSourceId} />
        <button className="ghost" aria-pressed={showBrowse} onClick={openBrowse}>places</button>
        <button className="ghost" aria-pressed={showSetup} onClick={() => setPanel((p) => (p === 'library' ? 'none' : 'library'))}>library</button>
      </div>

      <div className="globe-hint">
        drag to spin · scroll to zoom toward the cursor · click a dot to tune in
        {map.data ? ` · ${map.data.unmappedTracks} tracks have no mappable origin` : ''}
      </div>

      <SpotifyPlayer track={nowPlaying} />


      {/* Artist info, in this panel rather than on a page of its own. */}
      {infoId && (
        <div className="panel">
          <div className="panel-head">
            <button className="ghost" onClick={() => setInfoId(null)}>← back</button>
            <h1>{infoArtist?.name ?? 'Artist'}</h1>
            <button className="close" onClick={() => setInfoId(null)} aria-label="Close">×</button>
          </div>
          <ArtistDetail id={infoId} onPlay={setManual} nowPlayingUri={nowPlaying?.uri ?? null} />
        </div>
      )}

      {/* Search results: artists, never tracks. */}
      {q.trim() && !selectedQid && !infoId && (
        <div className="panel">
          <div className="panel-head">
            <h1>{matches.data?.total ?? 0} artists</h1>
            <button className="close" onClick={() => setText('')} aria-label="Clear search">×</button>
          </div>
          <p className="panel-sub">
            Lit dots are where these artists are from. Click a row for their tracks,
            ▶ to play something of theirs, <b>i</b> for details.
          </p>
          <ul className="artist-list">
            {matches.data?.items.map((a) => (
              <ArtistRow
                key={a.spotify_id}
                artist={a}
                onPlayArtist={playArtist}
                onPlayTrack={setManual}
                onInfo={setInfoId}
                nowPlayingUri={nowPlaying?.uri ?? null}
              />
            ))}
          </ul>
        </div>
      )}

      {showSetup && <SetupPanel onClose={() => setPanel('none')} />}

      {building && (selectedQid || isoFilter) && (
        <PlaylistBuilder
          placeQid={selectedQid ?? undefined}
          iso={isoFilter ?? undefined}
          placeName={filterLabel}
          onClose={() => setBuilding(false)}
        />
      )}

      {/* One panel for browsing and for a selected place. A dot click and a walk
          through the menu both set the URL, and this reads only from that, so
          they cannot diverge. */}
      {(showBrowse || hasFilter) && !infoId && !building && !showSetup && !q.trim() && (
        <PlaceView
          crumbs={crumbs}
          nested={nested}
          onNavigate={onNavigate}
          onHoverRow={setMenuHover}
          onClose={() => {
            close()
            setPanel('none')
          }}
          title={hasFilter ? filterLabel : 'Places'}
          subtitle={
            hasFilter ? (
              <>
                {selected
                  ? `${selected.tracks} tracks · ${selected.artists} artists`
                  : `${artists.data?.total ?? 0} artists`}
                <br />
                <span style={{ color: 'var(--dim)' }}>
                  {unknownFilter
                    ? 'No origin recorded in MusicBrainz or Wikidata for these.'
                    : 'Bands are placed where they formed; solo artists where they were born.'}
                </span>
              </>
            ) : null
          }
          actions={
            // Any selection that resolves to tracks can become a playlist — a
            // whole country as readily as one city. It sits above the artists so
            // it is reachable without scrolling past 200 rows.
            hasFilter && (selectedQid || isoFilter) ? (
              <button
                className="primary"
                style={{ marginBottom: 14 }}
                onClick={() => setBuilding(true)}
              >
                Make a {filterLabel} playlist
              </button>
            ) : null
          }
          body={
            hasFilter ? (
              <>
                <h2 style={{ marginTop: 14 }}>Artists</h2>
                <ul className="artist-list">
                  {artists.data?.items.map((a) => (
                    <ArtistRow
                      key={a.spotify_id}
                      artist={a}
                      onPlayArtist={playArtist}
                      onPlayTrack={setManual}
                      onInfo={setInfoId}
                      showPlace={a.city !== selected?.name}
                      nowPlayingUri={nowPlaying?.uri ?? null}
                    />
                  ))}
                </ul>
              </>
            ) : null
          }
        />
      )}
    </div>
  )
}
