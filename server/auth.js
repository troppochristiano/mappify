// Spotify Authorization Code + PKCE. No client secret.
//
// The flow used to spin up a throwaway HTTP server on 127.0.0.1:8888 and open a
// browser on whatever machine the server happened to be running on. That is a
// desktop app's flow, and it cannot work once anyone but the host connects: the
// callback has to come back to the *server*, and the server has to be able to
// tell which browser it belongs to. So the redirect URI is now this API's own
// /api/auth/callback, the PKCE verifier waits in control.db keyed by state, and
// success mints a session cookie.
//
// Tokens live in each user's own database and never leave the server. The web
// client is never given one.
//
// Development Mode reality: 5 authorized users per client ID, and the app owner
// needs Spotify Premium. Anyone not on the dashboard allowlist is rejected by
// Spotify before they ever reach this code — see allowlistHint().

import './env.js';
import crypto from 'node:crypto';
import { openControlDb, openUserDb } from './db.js';
import { currentDb, currentUserId } from './context.js';
import { rememberPending, claimPending, createSession } from './session.js';

/** Where a browser reaches this instance. Localhost is the self-hoster default. */
export const publicUrl = () =>
  (process.env.MAPPIFY_PUBLIC_URL ?? `http://127.0.0.1:${process.env.MAPPIFY_PORT ?? 6942}`).replace(
    /\/$/,
    ''
  );

export const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI ?? `${publicUrl()}/api/auth/callback`;

const SCOPES = [
  'user-library-read',      // liked songs
  'playlist-read-private',  // the user's own playlists
  'user-top-read',          // top artists/tracks
  'playlist-modify-private',
  'playlist-modify-public',
];

/**
 * The Spotify application this copy is. Environment first, then whatever was
 * entered on the setup screen.
 *
 * The second source exists because "open .env in a text editor and paste this
 * in" is where someone running Mappify on their own laptop gives up. A server
 * deployment sets the variable and never touches the stored one.
 */
export function clientId() {
  const fromEnv = process.env.SPOTIFY_CLIENT_ID?.trim();
  if (fromEnv) return fromEnv;

  const stored = openControlDb().prepare("SELECT value FROM settings WHERE key = 'client_id'").get();
  if (stored?.value) return stored.value;

  throw new Error(
    'No Spotify client ID yet.\n' +
      `  Register an app at developer.spotify.com, add redirect URI exactly ${REDIRECT_URI},\n` +
      '  then paste the client ID into the setup screen (or set SPOTIFY_CLIENT_ID).'
  );
}

export function hasClientId() {
  try {
    clientId();
    return true;
  } catch {
    return false;
  }
}

/**
 * Records the client id entered on the setup screen.
 *
 * Refused once one is configured, and refused entirely when the environment
 * supplies it: on a hosted instance this endpoint would otherwise let a stranger
 * repoint the whole thing at their own Spotify application.
 */
export function setClientId(id) {
  const clean = String(id ?? '').trim();
  if (!/^[a-f0-9]{32}$/i.test(clean)) {
    throw new Error('That does not look like a Spotify client ID — it is 32 letters and numbers.');
  }
  if (process.env.SPOTIFY_CLIENT_ID?.trim()) {
    throw new Error('The client ID is set by the environment on this instance.');
  }
  const db = openControlDb();
  const existing = db.prepare("SELECT value FROM settings WHERE key = 'client_id'").get();
  if (existing?.value) throw new Error('A client ID is already configured.');
  db.prepare("INSERT INTO settings (key, value) VALUES ('client_id', ?)").run(clean);
  return clean;
}

const b64url = (buf) => buf.toString('base64url');

async function tokenRequest(params) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Token request failed (${res.status}): ${json.error ?? ''} ${json.error_description ?? ''}`
    );
  }
  return json;
}

/**
 * Spotify's rejection for someone not on the app's allowlist is a bare
 * "invalid_grant / User not registered in the Developer Dashboard", which a
 * friend reads as "the app is broken" rather than "ask the host to add me".
 *
 * Development Mode caps an app at five authorised users and the host has to
 * paste each email into the dashboard by hand. Since that is the single most
 * likely way a new person fails to get in, it gets its own sentence.
 */
export function allowlistHint(message) {
  return /not registered in the developer dashboard|invalid_grant/i.test(message ?? '')
    ? 'Spotify has not been told about your account yet. Ask whoever runs this ' +
        'copy of Mappify to add your Spotify email in their developer dashboard, ' +
        'then try again.'
    : null;
}

function saveToken(db, tok, id, previousRefresh) {
  db.prepare(
    `INSERT INTO auth (id, client_id, access_token, refresh_token, expires_at, scope)
     VALUES (1,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       client_id=excluded.client_id, access_token=excluded.access_token,
       refresh_token=excluded.refresh_token, expires_at=excluded.expires_at,
       scope=excluded.scope`
  ).run(
    id,
    tok.access_token,
    // Spotify rotates PKCE refresh tokens; a response without one means keep the old.
    tok.refresh_token ?? previousRefresh ?? null,
    Date.now() + (tok.expires_in ?? 3600) * 1000,
    tok.scope ?? SCOPES.join(' ')
  );
}

const readToken = (db) => db.prepare('SELECT * FROM auth WHERE id = 1').get() ?? null;

export function authStatus() {
  const row = readToken(currentDb());
  if (!row?.refresh_token) return { connected: false };
  return {
    connected: true,
    expiresAt: row.expires_at,
    scope: row.scope,
    stale: Date.now() > row.expires_at,
  };
}

export function disconnect() {
  currentDb().prepare('DELETE FROM auth WHERE id = 1').run();
}

/**
 * Step one: the URL to send the browser to. The verifier stays here.
 *
 * @returns {{url: string, state: string}}
 */
export function beginAuth() {
  const id = clientId();
  const verifier = b64url(crypto.randomBytes(64));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  rememberPending(state, verifier);

  const url =
    'https://accounts.spotify.com/authorize?' +
    new URLSearchParams({
      client_id: id,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state,
      scope: SCOPES.join(' '),
    });

  return { url, state };
}

/**
 * Step two: trade the code for tokens, find out who just signed in, and give
 * them a session.
 *
 * The Spotify user id is the account identity, and it decides which database
 * file this person gets. Everything after this point is scoped by it.
 *
 * @returns {Promise<{userId: string, sessionId: string, displayName: string|null}>}
 */
export async function completeAuth(code, state) {
  const verifier = claimPending(state);
  if (!verifier) throw new Error('This sign-in link has expired or was already used. Try again.');

  const id = clientId();
  const tok = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: id,
    code_verifier: verifier,
  });

  const res = await fetch('https://api.spotify.com/v1/me', {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  });
  if (!res.ok) throw new Error(`Could not read your Spotify profile (${res.status})`);
  const me = await res.json();
  if (!me.id) throw new Error('Spotify returned a profile with no id');

  // The database is created by opening it, and the token goes straight into it —
  // so a user's credentials only ever exist inside their own file.
  const db = openUserDb(me.id);
  saveToken(db, tok, id, null);

  const control = openControlDb();
  control
    .prepare(
      `INSERT INTO users (spotify_id, display_name, created_at, last_seen_at)
       VALUES (?,?,?,?)
       ON CONFLICT(spotify_id) DO UPDATE SET
         display_name = excluded.display_name, last_seen_at = excluded.last_seen_at`
    )
    .run(me.id, me.display_name ?? null, new Date().toISOString(), new Date().toISOString());

  return { userId: me.id, sessionId: createSession(me.id), displayName: me.display_name ?? null };
}

/**
 * A valid access token for whoever the current request belongs to, refreshing if
 * needed.
 *
 * Reads the user from the async-scoped context rather than taking one, because
 * every caller is several frames below a route handler and a forgotten argument
 * here means reaching for someone else's account. No context, no token.
 */
export async function getAccessToken() {
  const id = clientId();
  const db = currentDb();
  const row = readToken(db);
  if (!row || row.client_id !== id || !row.refresh_token) {
    throw new Error(
      `Not connected to Spotify${currentUserId() ? ` for ${currentUserId()}` : ''}. Connect first.`
    );
  }
  if (row.access_token && Date.now() < row.expires_at - 60_000) return row.access_token;

  const tok = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: row.refresh_token,
    client_id: id,
  });
  saveToken(db, tok, id, row.refresh_token);
  return tok.access_token;
}
