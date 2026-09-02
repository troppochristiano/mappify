import { FloatingWindow } from './FloatingWindow'
import { friends as friendsApi, BAND_COPY, type CompareReport, type Friend } from '../lib/friends'

/**
 * The whole comparison as one still image, built to be screenshotted.
 *
 * Deliberately not a step in the sequence: the sequence is for reading and this
 * is for sending, so it says everything at once and moves nothing. Nothing here
 * scrolls or animates, because the thing people do with it is take a picture of
 * it, and half an animation in a screenshot is a broken-looking card.
 *
 * It lives in the generic FloatingWindow rather than in the right-hand panel —
 * this is not a view of the map, so it belongs over the middle of the screen
 * where a card belongs, and the camera is deliberately not told about it.
 */
export function WrappedCard({
  report,
  friend,
  onClose,
}: {
  report: CompareReport
  friend: Friend
  onClose: () => void
}) {
  const discovery = report.discoveries[0]

  return (
    <FloatingWindow
      title="Your match"
      subtitle={`You and ${friend.display_name}`}
      onClose={onClose}
      storageKey="mappify.wrapped"
      // Centred on first open; the window clamps this and remembers wherever it
      // is dragged to afterwards. 440 is just above FloatingWindow's 420 minimum.
      defaultRect={{
        x: Math.max(12, Math.round(window.innerWidth / 2 - 220)),
        y: Math.max(12, Math.round(window.innerHeight / 2 - 320)),
        w: 440,
        h: 640,
      }}
    >
      <div className="wrapped">
        <div className="wrapped-heads">
          <span className="avatar avatar-initials avatar-you" style={{ width: 52, height: 52 }}>
            You
          </span>
          {friend.has_avatar ? (
            <img
              className="avatar"
              style={{ width: 52, height: 52 }}
              src={friendsApi.avatarUrl(friend.id)}
              alt=""
              width={52}
              height={52}
            />
          ) : (
            <span className="avatar avatar-initials" style={{ width: 52, height: 52 }}>
              {friend.display_name.slice(0, 2).toUpperCase()}
            </span>
          )}
        </div>

        <div className="wrapped-score">
          <strong>{report.match}%</strong>
          <span>{report.band} match</span>
        </div>
        <p className="wrapped-copy">{BAND_COPY[report.band]}</p>

        <div className="wrapped-grid">
          <div>
            <b>{report.shared.artists.toLocaleString()}</b>
            <span>artists in common</span>
          </div>
          <div>
            <b>{report.shared.tracks.toLocaleString()}</b>
            <span>tracks in common</span>
          </div>
          <div>
            <b>{report.shared.places.toLocaleString()}</b>
            <span>cities in common</span>
          </div>
          <div>
            <b>{report.shared.countries.toLocaleString()}</b>
            <span>countries in common</span>
          </div>
        </div>

        {report.topSharedArtists.length > 0 && (
          <section className="wrapped-block">
            <h3>Both of you</h3>
            <p>{report.topSharedArtists.slice(0, 6).map((a) => a.name).join(' · ')}</p>
          </section>
        )}

        {/* The one panel here that no other music-comparison tool could print,
            so it gets its own block rather than a line in a list. */}
        {discovery && (
          <section className="wrapped-block wrapped-discovery">
            <h3>You could hear</h3>
            <p>
              <b>{discovery.artists.length}</b> artist
              {discovery.artists.length === 1 ? '' : 's'} from <b>{discovery.name}</b>
              {' '}you have never heard — a city you already have{' '}
              {discovery.yourTracks} tracks from.
            </p>
            <p className="wrapped-names">
              {discovery.artists.slice(0, 4).map((a) => a.name).join(' · ')}
            </p>
          </section>
        )}

        <section className="wrapped-block">
          <h3>Where you each listen</h3>
          <div className="wrapped-cities">
            <ol>
              {report.myTopPlaces.slice(0, 5).map((p) => (
                <li key={p.qid}>{p.name}</li>
              ))}
            </ol>
            <ol>
              {report.theirTopPlaces.slice(0, 5).map((p) => (
                <li key={p.qid}>{p.name}</li>
              ))}
            </ol>
          </div>
        </section>

        <p className="wrapped-foot">
          Mappify · counts are tracks in each library, not plays
        </p>
      </div>
    </FloatingWindow>
  )
}
