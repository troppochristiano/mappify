# Mappify

A globe of your music. Every artist in your Spotify library is placed where they
are actually from — resolved through MusicBrainz and Wikidata, not guessed from
names — so you can spin the world, tune into a city, hear something from it, and
turn any place into a playlist.

## What you need to know before you start

**Spotify allows five people per app.** Since February 2026, Development Mode is
*"limited to up to five authorized users"* and requires the app owner to hold
Spotify Premium. Getting past that needs Extended Quota, whose criteria are a
registered business, a launched service and 250,000 monthly active users.

There is no way around this: every endpoint that reads a user's library needs a
user token, and the OAuth flow that mints one enforces the allowlist. So Mappify
is self-hosted by design. If you want it for your friends, you register your own
Spotify app, add up to five accounts, and run your own copy. The heavy part — the
origin index — is shared, so you do not have to rebuild it.

## Setup

Requires **Node 22+** (24 recommended: `node:sqlite` runs unflagged).

1. **Register a Spotify app** at
   [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard).
   - Redirect URI must be exactly `http://127.0.0.1:8888/callback`.
     Spotify rejects `localhost` for loopback; it has to be the IP.
   - Tick **Web API**.
   - Add the Spotify accounts that will use it (up to five, including yours).

2. **Configure.**

   ```bash
   cp .env.example .env
   ```

   Fill in `SPOTIFY_CLIENT_ID` and `MB_CONTACT` (any address you can be reached
   at — MusicBrainz requires it in the User-Agent and throttles you without it).

3. **Install and run.**

   ```bash
   npm install --prefix web && npm run dev
   ```

   The API starts on 8787, the app on 5273. Open
   [localhost:5273](http://localhost:5273), click **library**, connect Spotify,
   and import.

## The origin index

Resolving an artist through the live MusicBrainz API costs two requests against a
hard limit of one per second, so a 600-artist library takes about 22 minutes. The
index turns that into a single indexed lookup — a few seconds for a whole library.

It is built from the MusicBrainz JSON dumps, whose artist records carry both the
areas and the `open.spotify.com/artist/...` links, so the entire
Spotify → MBID → city chain resolves offline. Coordinates and the city hierarchy
come from Wikidata, joined on `P982`.

**Using the shared index** (recommended): put `MAPPIFY_INDEX_URL` and
`MAPPIFY_INDEX_TOKEN` in `.env`. Nothing to download.

**Without it**, Mappify falls back to the live MusicBrainz path automatically. It
works, it is just slow, and it tells you so in the import panel.

**Building your own** (only if you are hosting an index for others):

```bash
node tools/build-mb-index.js --all
```

Downloads ~1.6 GB, needs `tar` with xz support, and takes a while. `--push`
uploads to a Turso database, whose free tier (5 GB, 500M reads/month) fits it
comfortably.

## What it does

- **Whole library.** Liked Songs and your playlists, imported together and
  filterable by source. Playlists you *follow* but do not own come in with their
  name and cover but no tracks — Spotify only returns contents for playlists you
  own or collaborate on, and the import says so rather than showing an empty list.
- **Globe.** Drag to spin, scroll to zoom, and a crosshair tunes to whatever is
  under it. Clicking a place plays a random track from it.
- **Geo playlists.** Turn any place into a private Spotify playlist. Selecting New
  York City includes Brooklyn, Harlem and the rest, because places nest.
- **Search.** Results are artists, not tracks, and matching dots stay lit on the
  globe while the rest dim.

## Things the data will do that look like bugs

**`begin-area` is not one thing.** For groups MusicBrainz records the city of
formation; for a solo artist it is the city of *birth*. Kanye West appears in
Atlanta because that is where he was born, not where the music happened. Artists
are tagged `person` or `group` so you can tell which reading applies.

**Cities are not rolled up.** Manhattan, Brooklyn, Queens, the Bronx and New York
are five separate places in MusicBrainz and there is no "NYC". They nest under New
York City here, but they stay distinct — Harlem is not silently relabelled.

**Administrative shells are folded in.** "Metropolitan City of Milan" wraps exactly
one city, so it collapses into Milan. Greater London holds eight boroughs, so it
does not. The rule is data-driven, not a list of names.

**Unknown is a real bucket.** Artists with no known origin are counted and shown,
never dropped or silently blanked.

## Layout

```
server/     API, import jobs, MusicBrainz/Wikidata clients, the index reader
tools/      build-mb-index.js — the dump-to-index builder
web/        React app (Vite)
```

## Credits

Artist and place data from [MusicBrainz](https://musicbrainz.org) (core data CC0)
and [Wikidata](https://www.wikidata.org) (CC0). Not affiliated with or endorsed by
Spotify.
