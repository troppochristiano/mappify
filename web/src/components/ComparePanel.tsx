import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  friends as friendsApi,
  BAND_COPY,
  type CompareReport,
  type Friend,
} from '../lib/friends'
import { WrappedCard } from './WrappedCard'

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
  visible,
  onVisible,
  colour,
  onColour,
}: {
  /** Lifted so the globe can overlay this friend's places. */
  selectedFriend: number | null
  onSelectFriend: (id: number | null) => void
  visible: boolean
  onVisible: (v: boolean) => void
  colour: string
  onColour: (c: string) => void
}) {
  const qc = useQueryClient()
  const [step, setStep] = useState(0)
  const [card, setCard] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const list = useQuery({ queryKey: ['friends'], queryFn: friendsApi.list })

  const comparison = useQuery({
    queryKey: ['compare', selectedFriend],
    queryFn: () => friendsApi.compare(selectedFriend!),
    enabled: selectedFriend != null,
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
      setStep(0)
    },
    onError: (err: Error) => setProblem(err.message),
  })

  const remove = useMutation({
    mutationFn: friendsApi.remove,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['friends'] })
      onSelectFriend(null)
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
          buttons, and the one that belongs to this panel stays in it. */}
      {selectedFriend != null && (
        <div className="dock-subhead">
          <button className="ghost back" onClick={() => onSelectFriend(null)}>
            ← all
          </button>
          <h2 className="dock-subtitle" style={{ margin: 0 }}>
            {friend?.display_name ?? 'Comparing'}
          </h2>
        </div>
      )}

      {selectedFriend == null ? (
        <>
          <p className="panel-sub">
            Send someone your library as a file, or open one they sent you. Nothing
            leaves this machine except the file you choose to share.
          </p>

          <div className="share-actions">
            {/* A real link, not a fetch: the browser downloads it without
                unloading the app, and there is nothing for JavaScript to add. */}
            <a className="primary" href={friendsApi.exportUrl()} download>
              Export my library
            </a>
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

          {problem && <p className="share-problem">{problem}</p>}

          <h2>Imported libraries</h2>
          {list.data?.friends.length ? (
            <ul className="friend-list">
              {list.data.friends.map((f) => (
                <FriendRow
                  key={f.id}
                  friend={f}
                  onOpen={() => {
                    onSelectFriend(f.id)
                    setStep(0)
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
          <OverlayControls
            friend={friend}
            visible={visible}
            onVisible={onVisible}
            colour={colour}
            onColour={onColour}
          />
          <Sequence report={report} friend={friend} step={step} onStep={setStep} />
          <button className="primary share-card-open" onClick={() => setCard(true)}>
            Open the card
          </button>
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
  onOpen,
  onRemove,
}: {
  friend: Friend
  onOpen: () => void
  onRemove: () => void
}) {
  return (
    <li className="friend-row">
      <button className="friend-open" onClick={onOpen}>
        <Avatar friend={friend} size={34} />
        <span className="friend-text">
          <b>{friend.display_name}</b>
          <em>
            {friend.tracks.toLocaleString()} tracks · {friend.places} places
          </em>
        </span>
      </button>
      <button
        className="friend-remove"
        onClick={onRemove}
        aria-label={`Remove ${friend.display_name}`}
        title="Remove"
      >
        ×
      </button>
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

/**
 * A short list rather than a full colour wheel.
 *
 * The only real requirement is "not the accent green and not white", since those
 * two already mean *your library* and *the one you mean*. Five hues that clear
 * both, spread far enough apart to tell two friends apart at a glance, beats a
 * picker that lets you choose a green three shades off the one underneath it.
 */
const FRIEND_COLOURS = ['#f0a726', '#e0508a', '#8b7cf0', '#33c4d8', '#e8543f']

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
      <button
        className="ghost overlay-toggle"
        aria-pressed={visible}
        onClick={() => onVisible(!visible)}
      >
        <span className="overlay-swatch" style={{ color: colour }} aria-hidden="true" />
        {visible ? 'On the globe' : 'Hidden'}
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

const STEPS = ['Match', 'For them', 'Shared', 'Cities'] as const

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
 */
function DiscoveriesStep({ report, friend }: { report: CompareReport; friend: Friend }) {
  const name = friend.display_name
  if (!report.discoveries.length) {
    return (
      <div className="compare-step">
        <p className="panel-sub">
          Nothing to offer from the cities {name} is deepest in — you either share
          those artists already, or your libraries are from different places
          entirely. Try <b>Cities</b>.
        </p>
      </div>
    )
  }
  return (
    <div className="compare-step">
      <p className="panel-sub">
        Artists you have that {name} has none of, from the cities they already
        know best.
      </p>
      {report.discoveries.slice(0, 6).map((d) => (
        <section key={d.qid} className="discovery">
          <h3>
            {d.name}
            <em>
              {d.artists.length} to offer · they have {d.theirTracks} tracks from here
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
