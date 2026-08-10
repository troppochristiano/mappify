import './env.js';
import { userAgent } from './env.js';
// MusicBrainz client. Hard 1 request/second, single in-flight queue.
// The User-Agent must identify the application and offer a way to reach whoever
// runs it; env.js has the one definition, with a project URL as the default.

const BASE = 'https://musicbrainz.org/ws/2';
const MIN_INTERVAL_MS = 1100; // 1 req/s with headroom for clock skew

let lastRequestAt = 0;
let chain = Promise.resolve();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Serialise every MB call through one chain so the rate limit holds
// regardless of how many callers there are.
function schedule(fn) {
  const run = chain.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fn();
  });
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * @returns {Promise<{status:number, json:any|null}>} 404 comes back as status 404
 *   with json null — "no match", not an error.
 */
export async function mbGet(path, { retries = 4 } = {}) {
  const url = `${BASE}${path}`;
  for (let attempt = 0; ; attempt++) {
    const res = await schedule(() =>
      fetch(url, {
        headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
      })
    );

    if (res.status === 404) {
      await res.arrayBuffer();
      return { status: 404, json: null };
    }

    if (res.status === 503 || res.status === 429) {
      await res.arrayBuffer();
      if (attempt >= retries) {
        throw new Error(`MusicBrainz ${res.status} after ${retries} retries: ${url}`);
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(16_000, 1500 * 2 ** attempt);
      console.log(`    MB ${res.status} — backing off ${Math.round(backoff / 1000)}s (attempt ${attempt + 1}/${retries})`);
      await sleep(backoff);
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`MusicBrainz ${res.status}: ${url}\n${body.slice(0, 400)}`);
    }

    return { status: res.status, json: await res.json() };
  }
}

/** Look an artist up by their Spotify URL. Never by name. */
export function lookupBySpotifyUrl(spotifyArtistId) {
  const resource = `https://open.spotify.com/artist/${spotifyArtistId}`;
  return mbGet(`/url?resource=${encodeURIComponent(resource)}&inc=artist-rels&fmt=json`);
}

/** Artist lookup: begin-area and area are what we need from it. */
export function lookupArtist(mbid) {
  return mbGet(`/artist/${mbid}?fmt=json`);
}
