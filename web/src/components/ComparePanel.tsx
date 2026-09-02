import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '../lib/api'
import {
  friends as friendsApi,
  BAND_COPY,
  type CompareReport,
  type Friend,
} from '../lib/friends'
import { WrappedCard } from './WrappedCard'
import { OverlayEye } from './OverlayEye'
// The palette lives with the overlay's other colour facts, because the route
// picks a default from it per library.
import { FRIEND_COLOURS } from './globe/layers'

/**
 * Share your library, and see how it lines up with somebody else's.
 *
 * Two states in one panel: a list of the files you have imported, and — once one
 * is picked — a short sequence that walks through the comparison a step at a
 * time rather than dropping nine statistics on screen at once. The steps are
 * ordered by what somebody actually wants to know: how close are we, what can I
 * give you, what do we already share, where are we each from.
 */
export function ComparePanel({
  selectedFriend,
  onSelectFriend,
  overlayIds,
  onToggleOverlay,
  visible,
  onVisible,
  colourOf,
  onColour,
}: {
  /** The library the comparison is about — pairwise, so exactly one. */
  selectedFriend: number | null
  onSelectFriend: (id: number | null) => void
  /** Every library drawn on the globe, in the order they stack. */
  overlayIds: number[]
  onToggleOverlay: (id: number) => void
  /** The master switch: whether any overlay is drawn at all. */
  visible: boolean
  onVisible: (v: boolean) => void
  /** Each library's own hue — see the colours map in the route. */
  colourOf: (id: number) => string
  onColour: (id: number, colour: string) => void
}) {
  const qc = useQueryClient()
  /**
   * The library being *read*, which is not the same thing as the one being
   * *drawn*.
   *
   * `selectedFriend` is the overlay: it belongs to the route, it survives this
   * panel, and it is now remembered between launches. This is the comparison you
   * opened, and it belongs to the panel — which is why it is plain state and
   * needs no resetting. Leaving the tab unmounts the panel, so coming back lands
   * on the list of libraries rather than back inside whichever one you last read.
   */
  const [openId, setOpenId] = useState<number | null>(null)
  const [step, setStep] = useState(0)
  const [card, setCard] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const list = useQuery({ queryKey: ['friends'], queryFn: friendsApi.list })
  // The same query the app shell already made, read from the cache rather than
  // asked again. `local` is what separates "there is a downloads bar" from "this
  // is a window with no browser around it".
  const setup = useQuery({ queryKey: ['setup'], queryFn: api.setup })
  const local = setup.data?.local ?? false

  /** Where the last export landed, so the file is findable without a browser. */
  const [saved, setSaved] = useState<string | null>(null)
  const exportFile = useMutation({
    mutationFn: friendsApi.exportToFile,
    onMutate: () => {
      setProblem(null)
      setSaved(null)
    },
    onSuccess: ({ path }) => setSaved(path),
    onError: (err: Error) => setProblem(err.message),
  })

  const comparison = useQuery({
    queryKey: ['compare', openId],
    queryFn: () => friendsApi.compare(openId!),
    enabled: openId != null,
  })

  const importFile = useMutation({
    mutationFn: friendsApi.import,
    onMutate: () => setProblem(null),
    onSuccess: ({ friend, skipped }) => {
      qc.invalidateQueries({ queryKey: ['friends'] })
      if (skipped) {
        // Said out loud rather than swallowed: a library quietly smaller than
        // the one that was sent would make every figure below it wrong in a way
        // nobody could see.
        setProblem(`Imported, but ${skipped} row${skipped === 1 ? '' : 's'} could not be read.`)
      }
      onSelectFriend(friend.id)
      setOpenId(friend.id)
      setStep(0)
    },
    onError: (err: Error) => setProblem(err.message),
  })

  const remove = useMutation({
    mutationFn: friendsApi.remove,
    // Told which one went, rather than clearing both regardless: deleting a
    // library you are not looking at used to take the overlay off the globe with
    // it, and the overlay might have been a different library entirely.
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['friends'] })
      if (id === selectedFriend) onSelectFriend(null)
      if (id === openId) setOpenId(null)
    },
  })

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // Reset first: picking the same file twice in a row fires no change event
    // otherwise, which reads as the import having silently failed.
    e.target.value = ''
    if (file) importFile.mutate(file)
  }

  const report = comparison.data?.report
  const friend = comparison.data?.friend

  return (
    <div>
      {/* Compare's own back, kept in the body rather than promoted to the dock
          head. The dock's back leaves a pushed view; this one steps out of one
          friend and into the list of them. Two different acts, so two different
          buttons, and the one that belongs to this panel stays in it.

          It leaves the comparison without taking the rings off the globe: which
          library you are reading and which one is drawn are two questions, and
          answering the first should not silently answer the second. */}
      {openId != null && (
        <div className="dock-subhead">
          <button className="ghost back" onClick={() => setOpenId(null)}>
            ← all
          </button>
          <h2 className="dock-subtitle" style={{ margin: 0 }}>
            {friend?.display_name ?? 'Comparing'}
          </h2>
        </div>
      )}

      {openId == null ? (
        <>
          <p className="panel-sub">
            Send someone your library as a file, or open one they sent you. Nothing
            leaves this machine except the file you choose to share.
          </p>
          {/* What is in the file, at the moment of sending it — which is the
              only moment the answer can change anything. Playlist names say more
              about a person than counts do, and they started travelling in a
              version somebody's copy may not have yet. */}
          <p className="fine">
            The file carries your artists, your tracks, the places they are from,
            and the names and covers of your playlists — Liked Songs and the ones
            you made, not your saved albums. Whoever opens it needs this version
            of Mappify or newer.
          </p>

          <div className="share-actions">
            {/* Two ways to hand over the same bytes, because the two builds hand
                them over differently. A browser tab has a downloads bar and a
                link is the honest control there. The downloaded app is a window
                with no browser chrome at all: the file would save with nothing
                on screen to say so, which reads as a button that does nothing.
                There, the server writes it and the app says where it went. */}
            {local ? (
              <button
                className="primary"
                onClick={() => exportFile.mutate()}
                disabled={exportFile.isPending}
              >
                {exportFile.isPending ? 'Saving…' : 'Export my library'}
              </button>
            ) : (
              <a className="primary" href={friendsApi.exportUrl()} download>
                Export my library
              </a>
            )}
            <button
              className="ghost"
              onClick={() => fileInput.current?.click()}
              disabled={importFile.isPending}
            >
              {importFile.isPending ? 'Reading…' : 'Import a file'}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".mappify"
              onChange={onFile}
              hidden
            />
          </div>

          {/* The path, in full and selectable. The window it is shown in cannot
              open a folder, so the least it can do is let you copy where the
              file is. */}
          {saved && (
            <p className="share-saved">
              Saved to <code>{saved}</code>
            </p>
          )}

          {problem && <p className="share-problem">{problem}</p>}

          {/* The switch for the whole overlay, on the heading it governs. The
              eyes down the list are about one library each; this one is about
              whether any of them is drawn at all, which is why it sits here and
              says so rather than naming a friend.

              Absent with nothing selected: there would be no rings for it to
              act on, and a control that cannot do anything is furniture. */}
          <div className="list-head">
            <h2>Imported libraries</h2>
            {overlayIds.length > 0 && (
              <button
                className="ghost pill-sm"
                aria-pressed={visible}
                aria-label="Show imported libraries on the globe"
                onClick={() => onVisible(!visible)}
              >
                {visible ? 'Showing on the globe' : 'Hidden from the globe'}
              </button>
            )}
          </div>
          {list.data?.friends.length ? (
            <ul className="friend-list">
              {list.data.friends.map((f) => (
                <FriendRow
                  key={f.id}
                  friend={f}
                  // Drawn, and actually showing, are two different things: a
                  // library can be on the globe with the master switch off.
                  overlaid={overlayIds.includes(f.id)}
                  visible={overlayIds.includes(f.id) && visible}
                  colour={colourOf(f.id)}
                  onOpen={() => {
                    setOpenId(f.id)
                    onSelectFriend(f.id)
                    setStep(0)
                  }}
                  // A plain per-library toggle now. There is no single overlay
                  // slot to take, so adding one no longer evicts another —
                  // several draw at once, each in its own colour. Turning one on
                  // also lifts the master switch, or the first library you add
                  // would appear to do nothing.
                  onEye={() => {
                    onToggleOverlay(f.id)
                    if (!overlayIds.includes(f.id)) onVisible(true)
                  }}
                  onRemove={() => remove.mutate(f.id)}
                />
              ))}
            </ul>
          ) : (
            <p className="panel-sub">
              Nobody yet. A <code>.mappify</code> file is what you get from Export
              above — send it however you like.
            </p>
          )}

          <p className="share-note">
            An imported file is a snapshot somebody chose to send you. It is not
            verified and it does not change your own library.
          </p>
        </>
      ) : comparison.isLoading ? (
        <p className="panel-sub">Working it out…</p>
      ) : comparison.error ? (
        <p className="share-problem">{String((comparison.error as Error).message)}</p>
      ) : report && friend ? (
        <>
          {/* The colour belongs here and only here: it is a choice about *this*
              library, and the list is a list of several. */}
          <OverlayControls
            friend={friend}
            visible={visible}
            onVisible={onVisible}
            colour={colourOf(friend.id)}
            onColour={(c) => onColour(friend.id, c)}
          />
          {/* Above the sequence rather than after it. The card is the thing
              people came here to send, and it was sitting below four steps of
              reading — so you had to scroll past the whole comparison to find
              the one control that gets you out of it. */}
          <button className="primary share-card-open" onClick={() => setCard((c) => !c)}>
            {card ? 'Close the card' : 'Open the card'}
          </button>
          <Sequence report={report} friend={friend} step={step} onStep={setStep} />
          {/* Portalled out of the dock: the card is a draggable window with a
              420px minimum, and the dock body is a 360px scroll container that
              would both clip it and be the containing block its dragging is
              measured against. */}
          {card &&
            createPortal(
              <WrappedCard report={report} friend={friend} onClose={() => setCard(false)} />,
              document.body
            )}
        </>
      ) : null}
    </div>
  )
}

function FriendRow({
  friend,
  overlaid,
  visible,
  colour,
  onOpen,
  onEye,
  onRemove,
}: {
  friend: Friend
  /** Whether this is the library currently drawn on the globe. */
  overlaid: boolean
  /** And whether its rings are actually showing. */
  visible: boolean
  colour: string
  onOpen: () => void
  onEye: () => void
  onRemove: () => void
}) {
  return (
    <li className={`friend-row${overlaid ? ' friend-row--on' : ''}`}>
      <button className="friend-open" onClick={onOpen}>
        <Avatar friend={friend} size={34} />
        <span className="friend-text">
          <b>{friend.display_name}</b>
          <em>
            {friend.tracks.toLocaleString()} tracks · {friend.places} places
            {/* Only when there are some. A library shared before playlists
                travelled has none and did not fail to — saying "0 playlists"
                would read as the file having been read badly. */}
            {friend.playlists ? ` · ${friend.playlists} playlists` : ''}
          </em>
        </span>
      </button>
      {/* Both controls in one group, on one baseline. They used to be a bare
          11px dot and a 16px glyph sitting next to each other on different
          metrics, which is what stopped them reading as a pair. */}
      <span className="friend-acts">
        <OverlayEye
          visible={visible}
          colour={colour}
          label={
            visible
              ? `Hide ${friend.display_name}'s places on the globe`
              : `Show ${friend.display_name}'s places on the globe`
          }
          onClick={onEye}
        />
        <button
          className="friend-remove"
          onClick={onRemove}
          aria-label={`Remove ${friend.display_name}`}
          title="Remove"
        >
          ×
        </button>
      </span>
    </li>
  )
}

/**
 * A face, or the next best thing.
 *
 * Initials rather than a placeholder graphic: an export carries an avatar only
 * when Spotify had one and it was small enough to embed, so "no picture" is a
 * normal outcome rather than an error worth drawing attention to.
 */
function Avatar({ friend, size }: { friend: Friend; size: number }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) }
  if (!friend.has_avatar) {
    return (
      <span className="avatar avatar-initials" style={style} aria-hidden="true">
        {friend.display_name.slice(0, 2).toUpperCase()}
      </span>
    )
  }
  return (
    <img
      className="avatar"
      style={style}
      src={friendsApi.avatarUrl(friend.id)}
      alt=""
      width={size}
      height={size}
    />
  )
}

function OverlayControls({
  friend,
  visible,
  onVisible,
  colour,
  onColour,
}: {
  friend: Friend
  visible: boolean
  onVisible: (v: boolean) => void
  colour: string
  onColour: (c: string) => void
}) {
  return (
    <div className="overlay-controls">
      {/* The label says what pressing it does to the rings, not merely where
          they are. "On the globe" was a true sentence that read as a status,
          which is exactly how a control gets mistaken for a caption. */}
      <button
        className="ghost overlay-toggle"
        aria-pressed={visible}
        onClick={() => onVisible(!visible)}
      >
        <span className="overlay-swatch" style={{ color: colour }} aria-hidden="true" />
        {visible ? 'Showing on the globe' : 'Hidden from the globe'}
      </button>
      <div className="overlay-colours" role="group" aria-label="Overlay colour">
        {FRIEND_COLOURS.map((c) => (
          <button
            key={c}
            className="overlay-colour"
            style={{ color: c }}
            aria-pressed={colour === c}
            aria-label={`Colour ${c}`}
            onClick={() => onColour(c)}
          />
        ))}
      </div>
      <p className="share-note overlay-note">
        {friend.display_name}&rsquo;s places are rings; yours stay solid inside
        them. Both are sized on one scale, so a smaller library really does look
        smaller.
      </p>
    </div>
  )
}

const STEPS = ['Match', 'For you', 'Shared', 'Cities'] as const

function Sequence({
  report,
  friend,
  step,
  onStep,
}: {
  report: CompareReport
  friend: Friend
  step: number
  onStep: (n: number) => void
}) {
  return (
    <>
      <div className="seg compare-steps" role="group" aria-label="Comparison">
        {STEPS.map((label, i) => (
          <button key={label} aria-pressed={step === i} onClick={() => onStep(i)}>
            {label}
          </button>
        ))}
      </div>

      {step === 0 && <MatchStep report={report} friend={friend} />}
      {step === 1 && <DiscoveriesStep report={report} friend={friend} />}
      {step === 2 && <SharedStep report={report} friend={friend} />}
      {step === 3 && <CitiesStep report={report} friend={friend} />}
    </>
  )
}

/**
 * Counts a number up, once, unless the reader would rather it did not.
 *
 * The whole point of the headline is that it is a verdict, and a verdict that
 * simply appears reads as a label where one that arrives reads as a result. Two
 * thirds of a second: long enough to register, short enough that nobody waits
 * for it.
 */
function useCountUp(target: number, ms = 650) {
  const [n, setN] = useState(target)
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // Nothing to animate into: a hidden document gets no animation frames at
    // all, so starting one here would leave the headline reading 0% until the
    // tab is focused — and it is the single number this whole panel exists to
    // report. The animation is decoration; the value is not.
    if (reduced || document.hidden) {
      setN(target)
      return
    }

    let raf = 0
    const start = performance.now()
    // Belt and braces for the same failure: if the tab is backgrounded partway
    // through, rAF stops firing and the last painted value sticks. This lands
    // shortly after the animation should have finished and settles the number
    // whatever happened to the frames. setTimeout is throttled in a background
    // tab but, unlike rAF, it is not suspended outright.
    const settle = window.setTimeout(() => setN(target), ms + 120)
    const onHide = () => {
      if (document.hidden) setN(target)
    }
    document.addEventListener('visibilitychange', onHide)

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms)
      // Ease out: fast enough to feel responsive, settling rather than stopping.
      setN(Math.round(target * (1 - (1 - t) ** 3)))
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    setN(0)
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(settle)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [target, ms])
  return n
}

function MatchStep({ report, friend }: { report: CompareReport; friend: Friend }) {
  const shown = useCountUp(report.match)
  return (
    <div className="compare-step">
      <div className="match-heads">
        <span className="avatar avatar-initials avatar-you" style={{ width: 44, height: 44 }}>
          You
        </span>
        <Avatar friend={friend} size={44} />
      </div>

      <div className="match-big">
        <strong>{shown}%</strong>
        <span className="match-band">{report.band}</span>
      </div>

      <p className="match-copy">{BAND_COPY[report.band]}</p>

      {report.confidence === 'low' && (
        <p className="share-problem">
          One of these libraries is small enough that this number is mostly noise.
        </p>
      )}

      {/* The honest figure, next to the presented one. A percentage whose real
          ceiling is about 50 would read as a failing grade on its own, so it is
          curved for display — and saying so is what keeps that defensible. */}
      <p className="match-maths">
        Similarity {report.scores.artists.toFixed(2)} of 1, scaled for display.
        Two unrelated libraries sit near 0.08.
      </p>

      <dl className="match-facts">
        <div>
          <dt>Artists in common</dt>
          <dd>{report.shared.artists.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Tracks in common</dt>
          <dd>{report.shared.tracks.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Cities in common</dt>
          <dd>{report.shared.places.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Countries in common</dt>
          <dd>{report.shared.countries.toLocaleString()}</dd>
        </div>
      </dl>
      <p className="share-note">
        Counts are tracks in each library. Mappify never sees what you play.
      </p>
    </div>
  )
}

/**
 * The step this whole feature exists for.
 *
 * Everything else here could be computed by any of the sites that compare two
 * Spotify accounts. This one needs to know where artists are from, which is the
 * only thing Mappify has that they do not.
 *
 * It reads inward: their artists, in the cities you are deepest in. It used to
 * read outward — your artists, for cities they were deep in, under a step called
 * "For them" — which is a fine thing to know and the wrong thing to open
 * somebody else's library to find out.
 */
function DiscoveriesStep({ report, friend }: { report: CompareReport; friend: Friend }) {
  const name = friend.display_name
  if (!report.discoveries.length) {
    return (
      <div className="compare-step">
        <p className="panel-sub">
          Nothing new from the cities you are deepest in — you either have those
          artists already, or your libraries are from different places entirely.
          Try <b>Cities</b>.
        </p>
      </div>
    )
  }
  return (
    <div className="compare-step">
      <p className="panel-sub">
        Artists {name} has that you have none of, from the cities you already
        know best.
      </p>
      {report.discoveries.slice(0, 6).map((d) => (
        <section key={d.qid} className="discovery">
          <h3>
            {d.name}
            <em>
              {d.artists.length} to hear · you have {d.yourTracks} tracks from here
            </em>
          </h3>
          <ul className="artist-list">
            {d.artists.slice(0, 5).map((a) => (
              <li key={a.id} className="mini-row">
                {a.image_url ? (
                  <img src={a.image_url} alt="" width={28} height={28} loading="lazy" />
                ) : (
                  <span className="mini-blank" aria-hidden="true" />
                )}
                <span className="mini-name">{a.name}</span>
                <span className="mini-count">{a.tracks}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function SharedStep({ report, friend }: { report: CompareReport; friend: Friend }) {
  if (!report.topSharedArtists.length) {
    return (
      <div className="compare-step">
        <p className="panel-sub">Not one artist in common. That is genuinely rare.</p>
      </div>
    )
  }
  return (
    <div className="compare-step">
      <p className="panel-sub">
        Ranked by how much you <em>both</em> have of them, so an artist one of you
        has heard of once does not lead the list.
      </p>
      <ul className="artist-list">
        {report.topSharedArtists.map((a) => (
          <li key={a.id} className="mini-row">
            {a.image_url ? (
              <img src={a.image_url} alt="" width={28} height={28} loading="lazy" />
            ) : (
              <span className="mini-blank" aria-hidden="true" />
            )}
            <span className="mini-name">{a.name}</span>
            <span className="mini-split" title={`you ${a.mine} · ${friend.display_name} ${a.theirs}`}>
              {a.mine} / {a.theirs}
            </span>
          </li>
        ))}
      </ul>
      <p className="share-note">Your tracks / theirs.</p>
    </div>
  )
}

function CitiesStep({ report, friend }: { report: CompareReport; friend: Friend }) {
  const shared = new Set(report.topSharedPlaces.map((p) => p.qid))
  const column = (title: string, places: CompareReport['myTopPlaces']) => (
    <div className="city-column">
      <h3>{title}</h3>
      <ol>
        {places.map((p) => (
          <li key={p.qid} className={shared.has(p.qid) ? 'city-shared' : undefined}>
            <span>{p.name}</span>
            <em>{p.tracks}</em>
          </li>
        ))}
      </ol>
    </div>
  )
  return (
    <div className="compare-step">
      <div className="city-columns">
        {column('You', report.myTopPlaces)}
        {column(friend.display_name, report.theirTopPlaces)}
      </div>
      <p className="share-note">
        Highlighted cities are in both libraries. Bands are placed where they
        formed; solo artists where they were born.
      </p>
    </div>
  )
}
