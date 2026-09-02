/**
 * A harness for the two views an imported library's playlists are read through.
 *
 * Reaching either in the real app takes a Spotify session, an import of your own
 * and a `.mappify` file from somebody else who is on a build new enough to have
 * sent playlists at all — which is three preconditions too many for a check on
 * how a row looks. `fetch` is answered from a table instead.
 *
 * The states worth seeing side by side are the ones that differ in what they
 * have to admit: a playlist you have none of, one you already have all of, and
 * one longer than the server will send in a page.
 *
 * Dev only. Not imported by the app, and not in the production bundle.
 */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FriendPlaylistPanel } from './components/FriendPlaylistPanel'
import { SearchPanel } from './components/SearchPanel'
import './styles.css'

const COVER = 'https://mosaic.scdn.co/640/' + 'ab67616d00001e02'.repeat(4)

const PLAYLISTS: Record<number, { name: string; tracks: number; mineEvery: number }> = {
  1: { name: 'mojave desert', tracks: 22, mineEvery: 0 }, // none of it yours
  2: { name: 'Both of ours', tracks: 14, mineEvery: 1 }, // all of it yours
  3: { name: 'Liked Songs', tracks: 1990, mineEvery: 3 }, // longer than a page
}

window.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input), location.origin)
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })

  if (url.pathname === '/api/friend-playlist-tracks') {
    const p = PLAYLISTS[Number(url.searchParams.get('source'))]
    const shown = Math.min(p.tracks, 500)
    const tracks = Array.from({ length: shown }, (_, i) => ({
      spotify_id: `t${i}`,
      name: `Track ${i + 1}`,
      artist: i % 4 === 0 ? null : `Artist ${i % 7}`,
      mine: p.mineEvery && i % p.mineEvery === 0 ? 1 : 0,
    }))
    return json({
      playlist: {
        source_id: 1,
        kind: p.name === 'Liked Songs' ? 'liked' : 'playlist',
        name: p.name,
        image_url: COVER,
        tracks: p.tracks,
        missing: tracks.filter((t) => !t.mine).length,
      },
      tracks,
      shown,
    })
  }

  if (url.pathname === '/api/search') {
    const theirs = url.searchParams.get('scope') === 'theirs'
    return json({
      artists: [],
      places: theirs
        ? [{ qid: 'Q60', name: 'New York', country_iso: 'US', artists: 12, tracks: 40, owner: 'theirs', friend_id: 4 }]
        : [],
      playlists: theirs
        ? Object.entries(PLAYLISTS).map(([id, p]) => ({
            id: Number(id),
            kind: p.name === 'Liked Songs' ? 'liked' : 'playlist',
            name: p.name,
            image_url: COVER,
            imported: p.tracks,
            owner: 'theirs',
            friend_id: 4,
          }))
        : [{ id: 9, kind: 'playlist', name: 'One of mine', image_url: null, imported: 30 }],
      scope: theirs ? 'theirs' : 'mine',
      friends: theirs ? [4] : [],
    })
  }

  // Chip labels, which the panel asks for on mount.
  return json({ labels: {}, targets: [], limits: { requested: 0, applied: 0, dropped: [], invalid: 0 } })
}) as typeof fetch

function Harness() {
  const [opened, setOpened] = useState<{ id: number; name: string } | null>(null)
  const [scope, setScope] = useState<'mine' | 'theirs' | 'both'>('theirs')
  return (
    <div style={{ display: 'flex', gap: 20, padding: 20, alignItems: 'flex-start' }}>
      <div style={{ width: 336 }}>
        <h2>Search, scope: imported</h2>
        <SearchPanel
          text=""
          onText={() => {}}
          chips={[]}
          onAdd={() => {}}
          onToggle={() => {}}
          onRemove={() => {}}
          onClear={() => {}}
          onSelectPlace={() => {}}
          onOpenArtist={() => {}}
          onOpenFriendPlaylist={(_friendId, sourceId, name) => setOpened({ id: sourceId, name })}
          friendIds={[4]}
          friendColourOf={() => '#ff7ac6'}
          friendNameOf={() => 'Leonardo'}
          scope={scope}
          onScope={setScope}
        />
      </div>
      <div style={{ width: 336 }}>
        <h2>Opened: {opened?.name ?? '— click a playlist —'}</h2>
        {opened && (
          <FriendPlaylistPanel
            friendId={4}
            sourceId={opened.id}
            onPlayTrack={(t) => console.log('play', t)}
            nowPlayingUri={null}
          />
        )}
      </div>
      {[1, 2, 3].map((id) => (
        <div key={id} style={{ width: 336 }}>
          <h2>{PLAYLISTS[id].name}</h2>
          <FriendPlaylistPanel friendId={4} sourceId={id} onPlayTrack={() => {}} />
        </div>
      ))}
    </div>
  )
}

const qc = new QueryClient()
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={qc}>
    <Harness />
  </QueryClientProvider>
)
