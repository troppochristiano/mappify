// Whether anyone still has Mappify open, and shutting down when nobody does.
//
// A double-clickable build has no console to close and no window of its own, so
// without this it runs until the machine reboots — invisibly, holding the port.
// The browser tab is the window; when the last one goes, so should the server.
//
// Only ever armed on a loopback instance. A hosted copy serves people who did
// not start it and must not be stopped by the last of them wandering off.

/** How long a tab may go quiet before it is presumed gone. */
const GRACE_MS = Number(process.env.MAPPIFY_IDLE_GRACE_MS ?? 90_000);

/**
 * Ninety seconds against a ten-second heartbeat looks generous, and is, for one
 * specific reason: browsers throttle timers in hidden tabs. Chrome clamps an
 * interval in a backgrounded tab to roughly once a minute, so a 60s window would
 * shut the server down on someone who simply switched to another tab and came
 * back. Being half a minute late to exit costs nothing; exiting under someone
 * costs them their session.
 */
const BYE_GRACE_MS = Math.min(5_000, GRACE_MS / 2);
const SWEEP_MS = Math.min(5_000, Math.max(250, GRACE_MS / 10));

/** Quiet period after any work finishes, so a shutdown never treads on its tail. */
const COOLDOWN_MS = Math.min(30_000, GRACE_MS / 3);

const seen = new Map(); // tab id -> last heartbeat, ms
let armed = false; // no browser has ever checked in
let lastBusyAt = 0;

export function beat(tabId) {
  if (!tabId) return;
  armed = true;
  seen.set(tabId, Date.now());
}

/**
 * A tab saying it is going away.
 *
 * Shortens its window rather than dropping it, because `pagehide` fires on a
 * reload exactly as it does on a close. Deleting outright would let a sweep land
 * in the gap between the old page leaving and the new one arriving, and the app
 * would vanish mid-refresh.
 */
export function bye(tabId) {
  if (!tabId || !seen.has(tabId)) return;
  seen.set(tabId, Date.now() - GRACE_MS + BYE_GRACE_MS);
}

/**
 * @param {object} opts
 * @param {() => boolean} opts.isBusy work that must not be interrupted — an
 *   import, or a request still in flight.
 * @param {() => void} opts.onQuit
 */
export function armAutoQuit({ isBusy, onQuit }) {
  let fired = false;
  const timer = setInterval(() => {
    if (fired) return; // process.exit is not instant; do not ask twice
    // Wrapped, because a throw inside a timer exits the process with a non-zero
    // code — so a bug here would leave a stack trace on the console for what
    // should be a silent, expected shutdown.
    try {
      if (!armed) return; // started with no browser yet, e.g. `npm run server`
      if (isBusy()) {
        lastBusyAt = Date.now();
        return;
      }
      if (Date.now() - lastBusyAt < COOLDOWN_MS) return;

      const now = Date.now();
      for (const at of seen.values()) if (now - at < GRACE_MS) return;

      fired = true;
      onQuit();
    } catch (err) {
      console.log(`  ! idle check failed, staying up: ${err.message}`);
    }
  }, SWEEP_MS);

  // Never the reason the process stays alive.
  timer.unref?.();
  return timer;
}

export const graceMs = GRACE_MS;
