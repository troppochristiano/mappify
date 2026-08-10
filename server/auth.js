// Spotify Authorization Code + PKCE. No client secret.
//
// Ported from liked-origins, with the token now living in the `auth` table
// rather than a JSON file. Redirect URI must be the loopback IP — Spotify
// rejects "localhost" for loopback.
//
// Development Mode reality: 5 authorized users per client ID, and the app owner
// needs Spotify Premium. Anyone not on the dashboard allowlist is rejected by
// Spotify before they ever reach this code.

import './env.js';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { openDb } from './db.js';

export const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI ?? 'http://127.0.0.1:8888/callback';
const CALLBACK_PORT = Number(new URL(REDIRECT_URI).port || 80);

const SCOPES = [
  'user-library-read',      // liked songs
  'playlist-read-private',  // the user's own playlists
  'user-top-read',          // top artists/tracks
  'playlist-modify-private',
  'playlist-modify-public',
];

export function clientId() {
  const id = process.env.SPOTIFY_CLIENT_ID?.trim();
  if (!id) {
    throw new Error(
      'SPOTIFY_CLIENT_ID is not set.\n' +
        `  Register an app at developer.spotify.com, add redirect URI exactly ${REDIRECT_URI},\n` +
        '  then put the client ID in .env or the environment.'
    );
  }
  return id;
}

const b64url = (buf) => buf.toString('base64url');

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')], {
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: true,
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* the URL is printed as well */
  }
}

const PAGE = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
  body{background:#121212;color:#fff;font:14px system-ui,sans-serif;margin:0;
       display:flex;align-items:center;justify-content:center;height:100vh}
  div{background:#181818;border-radius:10px;padding:28px 36px;text-align:center}
  h1{font-size:16px;margin:0 0 8px}p{margin:0;color:#b3b3b3}
  b{color:#1db954}
</style>
<div><h1>${title}</h1><p>${body}</p></div>`;

function waitForCode(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== new URL(REDIRECT_URI).pathname) {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      const finish = (status, title, body, cb) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE(title, body));
        server.close(cb);
      };

      if (error) return finish(400, 'Authorization failed', error, () => reject(new Error(error)));
      if (state !== expectedState)
        return finish(400, 'State mismatch', 'Response discarded.', () =>
          reject(new Error('OAuth state mismatch'))
        );
      if (!code)
        return finish(400, 'No code', 'Spotify returned no authorization code.', () =>
          reject(new Error('no code in callback'))
        );

      finish(200, '<b>Connected</b>', 'You can close this tab and go back to Mappify.', () =>
        resolve(code)
      );
    });

    server.on('error', (err) =>
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`Port ${CALLBACK_PORT} is already in use — free it and retry.`)
          : err
      )
    );
    server.listen(CALLBACK_PORT, '127.0.0.1');
  });
}

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

function saveToken(tok, id, previousRefresh) {
  const db = openDb();
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
  db.close();
}

function readToken() {
  const db = openDb();
  const row = db.prepare('SELECT * FROM auth WHERE id = 1').get();
  db.close();
  return row ?? null;
}

export function authStatus() {
  const row = readToken();
  if (!row?.refresh_token) return { connected: false };
  return {
    connected: true,
    expiresAt: row.expires_at,
    scope: row.scope,
    stale: Date.now() > row.expires_at,
  };
}

export function disconnect() {
  const db = openDb();
  db.prepare('DELETE FROM auth WHERE id = 1').run();
  db.close();
}

/** Runs the browser flow. Resolves once the callback lands. */
export async function authorize({ onUrl } = {}) {
  const id = clientId();
  const verifier = b64url(crypto.randomBytes(64));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  const authUrl =
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

  const pending = waitForCode(state);
  onUrl?.(authUrl);
  openBrowser(authUrl);

  const code = await pending;
  const tok = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: id,
    code_verifier: verifier,
  });
  saveToken(tok, id, null);
  return true;
}

/**
 * A valid access token, refreshing if needed. Throws rather than opening a
 * browser — the API server must never block on a human.
 */
export async function getAccessToken() {
  const id = clientId();
  const row = readToken();
  if (!row || row.client_id !== id || !row.refresh_token) {
    throw new Error('Not connected to Spotify. Run the connect flow first.');
  }
  if (row.access_token && Date.now() < row.expires_at - 60_000) return row.access_token;

  const tok = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: row.refresh_token,
    client_id: id,
  });
  saveToken(tok, id, row.refresh_token);
  return tok.access_token;
}
