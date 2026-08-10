// Spotify Web API client and library reader.
//
// Written against the February 2026 API, which removed a lot:
//   - POST /users/{id}/playlists  ->  POST /me/playlists
//   - playlist /tracks            ->  /items
//   - GET /users/{id}/playlists, GET /users/{id}, GET /markets  — gone
//   - GET /artists (batch), GET /tracks (batch), etc.            — gone, fetch individually
//   - search limit max is now 10, not 50
//
// And the constraint that shapes the import: playlist items "are only returned
// for playlists the user owns or collaborates on", so followed playlists come
// back with a name and cover but no tracks. That is reported, not swallowed.

import { getAccessToken } from '../auth.js';

const API = 'https://api.spotify.com/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function api(pathOrUrl, { method = 'GET', body, retries = 5 } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API}${pathOrUrl}`;

  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken();
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429) {
      await res.arrayBuffer();
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter >= 0 ? (retryAfter + 1) * 1000 : 5000;
      await sleep(wait);
      continue;
    }
    if (res.status === 204) return null;

    if (!res.ok) {
      const text = await res.text();
      if ((res.status >= 500 || res.status === 408) && attempt < retries) {
        await sleep(Math.min(20_000, 1000 * 2 ** attempt));
        continue;
      }
      const err = new Error(`Spotify ${res.status} ${method} ${url}\n${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }
}

export const me = () => api('/me');

const trackOf = (t) =>
  !t || !t.id || t.is_local
    ? null
    : {
        id: t.id,
        name: t.name,
        uri: t.uri,
        url: t.external_urls?.spotify ?? `https://open.spotify.com/track/${t.id}`,
        album: t.album?.name ?? '',
        albumImage: t.album?.images?.[0]?.url ?? null,
        durationMs: t.duration_ms ?? null,
        artists: (t.artists ?? []).map((a) => ({ id: a.id, name: a.name })).filter((a) => a.id),
      };

/** Liked Songs. */
export async function fetchLiked({ onProgress } = {}) {
  const tracks = [];
  const skipped = { local: 0, nullTrack: 0 };
  let url = '/me/tracks?limit=50';
  let total = null;

  while (url) {
    const page = await api(url);
    total ??= page.total;
    for (const item of page.items ?? []) {
      const t = trackOf(item?.track);
      if (!t) {
        if (item?.track?.is_local) skipped.local++;
        else skipped.nullTrack++;
        continue;
      }
      tracks.push({ ...t, addedAt: item.added_at ?? null });
    }
    onProgress?.(tracks.length, total ?? 0);
    url = page.next;
  }
  return { tracks, skipped, total: total ?? tracks.length };
}

/**
 * Saved albums. Survived the Feb 2026 library consolidation as a read endpoint,
 * and each album carries its full track list, so no per-album follow-up call.
 */
export async function fetchSavedAlbums({ onProgress } = {}) {
  const albums = [];
  let url = '/me/albums?limit=50';
  let total = null;

  while (url) {
    const page = await api(url);
    total ??= page.total;
    for (const item of page.items ?? []) {
      const al = item?.album;
      if (!al?.id) continue;
      const image = al.images?.[0]?.url ?? null;
      // Album tracks omit the album object they came from, so it is stitched
      // back on here — otherwise every track loses its cover and album name.
      const tracks = (al.tracks?.items ?? al.items?.items ?? [])
        .map((t) =>
          trackOf({ ...t, album: { name: al.name, images: al.images } })
        )
        .filter(Boolean)
        .map((t) => ({ ...t, addedAt: item.added_at ?? null }));
      albums.push({
        id: al.id,
        name: al.name,
        image,
        artistNames: (al.artists ?? []).map((a) => a.name).join(', '),
        trackTotal: al.total_tracks ?? tracks.length,
        tracks,
      });
    }
    onProgress?.(albums.length, total ?? 0);
    url = page.next;
  }
  return { albums, total: total ?? albums.length };
}

/** Every playlist the account can see, owned or not. */
export async function fetchPlaylists() {
  const playlists = [];
  let url = '/me/playlists?limit=50';
  while (url) {
    const page = await api(url);
    for (const p of page.items ?? []) {
      if (!p?.id) continue;
      playlists.push({
        id: p.id,
        name: p.name ?? '(untitled)',
        ownerId: p.owner?.id ?? null,
        ownerName: p.owner?.display_name ?? null,
        snapshotId: p.snapshot_id ?? null,
        // Feb 2026 renamed the playlist's own track summary from `tracks` to
        // `items`, same as the endpoint. Without the first branch every playlist
        // reports zero tracks and looks empty.
        trackTotal: p.items?.total ?? p.tracks?.total ?? 0,
        image: p.images?.[0]?.url ?? null,
        collaborative: Boolean(p.collaborative),
      });
    }
    url = page.next;
  }
  return playlists;
}

/**
 * A playlist's tracks. Returns `{tracks, readable}` — `readable: false` means
 * Spotify withheld the contents because the account does not own the playlist.
 */
export async function fetchPlaylistItems(playlistId, { onProgress } = {}) {
  const tracks = [];
  let url = `/playlists/${playlistId}/items?limit=100`;
  try {
    while (url) {
      const page = await api(url);
      for (const item of page.items ?? []) {
        // Feb 2026 renamed the wrapper from `track` to `item`; accept both so a
        // partially-migrated response cannot silently yield zero tracks.
        const t = trackOf(item?.item ?? item?.track);
        if (!t) continue;
        tracks.push({ ...t, addedAt: item.added_at ?? null });
      }
      onProgress?.(tracks.length);
      url = page.next;
    }
  } catch (err) {
    if (err.status === 403 || err.status === 404) return { tracks: [], readable: false };
    throw err;
  }
  return { tracks, readable: true };
}

/** Artist detail, one at a time — the batch endpoint was removed. */
export async function fetchArtist(id) {
  const a = await api(`/artists/${id}`);
  return {
    id: a.id,
    name: a.name,
    image: a.images?.[0]?.url ?? null,
  };
}

export async function topArtists(timeRange = 'medium_term') {
  const page = await api(`/me/top/artists?limit=50&time_range=${timeRange}`);
  return (page.items ?? []).map((a, i) => ({
    id: a.id,
    name: a.name,
    image: a.images?.[0]?.url ?? null,
    rank: i + 1,
  }));
}

/** Creates a private playlist. POST /me/playlists — the /users/ form is gone. */
export async function createPlaylist(name, uris, { description } = {}) {
  const playlist = await api('/me/playlists', {
    method: 'POST',
    body: {
      name,
      public: false,
      description: description ?? 'Built by Mappify',
    },
  });
  for (let i = 0; i < uris.length; i += 100) {
    await api(`/playlists/${playlist.id}/items`, {
      method: 'POST',
      body: { uris: uris.slice(i, i + 100) },
    });
  }
  return {
    id: playlist.id,
    name: playlist.name,
    url: playlist.external_urls?.spotify ?? null,
    added: uris.length,
  };
}
