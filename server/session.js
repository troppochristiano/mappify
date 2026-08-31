// Browser sessions: the cookie that says which library a request may open.
//
// Spotify OAuth is the whole login. There are no passwords here, no account
// system, and nothing to reset — signing in means proving to Spotify that you
// are you, and this file only remembers that it happened.

import crypto from 'node:crypto';
import { openControlDb } from './db.js';

const COOKIE = 'mappify_session';
const TTL_MS = 30 * 24 * 3600 * 1000;
const PENDING_TTL_MS = 15 * 60 * 1000;

/** True when this instance is reached over https, which decides Secure. */
const secure = () => (process.env.MAPPIFY_PUBLIC_URL ?? '').startsWith('https://');

// Stored hashed, not raw. The cookie is a bearer token: anyone holding the value
// is the user. Hashing means a stolen copy of control.db yields a list of
// expiry dates rather than a set of working sessions.
const hash = (id) => crypto.createHash('sha256').update(id).digest('hex');

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function createSession(userId) {
  const db = openControlDb();
  const id = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(
    hash(id),
    userId,
    new Date().toISOString(),
    Date.now() + TTL_MS
  );
  return id;
}

/** @returns {string|null} the user id this request may act as */
export function userForRequest(req) {
  const id = parseCookies(req.headers.cookie ?? '')[COOKIE];
  if (!id) return null;
  const db = openControlDb();
  const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?').get(hash(id));
  if (!row) return null;
  if (Date.now() > row.expires_at) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(hash(id));
    return null;
  }
  return row.user_id;
}

export function endSession(req) {
  const id = parseCookies(req.headers.cookie ?? '')[COOKIE];
  if (!id) return;
  openControlDb().prepare('DELETE FROM sessions WHERE id = ?').run(hash(id));
}

export const sessionCookie = (id) =>
  [
    `${COOKIE}=${id}`,
    'Path=/',
    'HttpOnly',
    // Lax rather than Strict: the sign-in returns from accounts.spotify.com as a
    // top-level navigation, and Strict would withhold the cookie on exactly that
    // request, so the user would land back on the app still signed out.
    'SameSite=Lax',
    `Max-Age=${Math.floor(TTL_MS / 1000)}`,
    ...(secure() ? ['Secure'] : []),
  ].join('; ');

export const clearCookie = () =>
  `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure() ? '; Secure' : ''}`;

/** PKCE verifiers for flows in progress, keyed by the state we sent Spotify. */
export function rememberPending(state, verifier) {
  const db = openControlDb();
  db.prepare('DELETE FROM pending_auth WHERE created_at < ?').run(Date.now() - PENDING_TTL_MS);
  db.prepare('INSERT INTO pending_auth (state, verifier, created_at) VALUES (?,?,?)').run(
    state,
    verifier,
    Date.now()
  );
}

/**
 * Whether a sign-in is part-way through — sent to Spotify, not yet come back.
 *
 * The idle shutdown needs this. Clicking Connect navigates the only tab away to
 * accounts.spotify.com, which fires `pagehide`, which tells this server the tab
 * is going — so from here a sign-in looks exactly like somebody closing the app.
 * Thirty seconds later the sweep would find no live tab and exit, and the
 * callback would come back to a closed port. The first sign-in on a machine is
 * the slowest one there is, being the one with a password and possibly a second
 * factor in it, so it is the most likely to be shut down halfway.
 *
 * A row here lives fifteen minutes at most and is deleted the moment it is
 * redeemed, so an abandoned sign-in cannot hold the server up for longer than
 * the flow could have taken anyway.
 */
export function pendingAuth() {
  const db = openControlDb();
  const row = db
    .prepare('SELECT 1 AS yes FROM pending_auth WHERE created_at > ? LIMIT 1')
    .get(Date.now() - PENDING_TTL_MS);
  return Boolean(row);
}

/** Single use: a state that has been redeemed cannot be replayed. */
export function claimPending(state) {
  const db = openControlDb();
  const row = db.prepare('SELECT verifier, created_at FROM pending_auth WHERE state = ?').get(state);
  if (!row) return null;
  db.prepare('DELETE FROM pending_auth WHERE state = ?').run(state);
  return Date.now() - row.created_at > PENDING_TTL_MS ? null : row.verifier;
}
