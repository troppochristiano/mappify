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
   - Redirect URI must be exactly `http://127.0.0.1:8787/api/auth/callback`.
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
   [localhost:5273](http://localhost:5273), connect Spotify, and import. If
   either port is taken, both move and the console says where — but the API on
   anything other than 8787 means the redirect URI no longer matches the one you
   registered, and Spotify will refuse the sign-in.

## Hosting it for other people

Everyone gets their own map. Each account that signs in gets its own database
under `data/`, and its own Spotify tokens; nobody can see anyone else's library.

The five-account cap is per Spotify **application**, so this is the pattern: one
person hosts, registers their own app, and adds up to five friends' emails. Every
group runs its own copy and gets its own five slots.

### On a free Google Cloud VM

An `e2-micro` in `us-west1`, `us-central1` or `us-east1` is always-free and more
than this needs. Anything else running Debian or Ubuntu works identically.

1. Create the VM (`e2-micro`, Debian 12, allow HTTP and HTTPS traffic).
2. Point a domain at its external IP with an `A` record. It has to be a real
   domain: Spotify only allows `http://` redirect URIs for loopback, so a bare
   IP cannot be used and HTTPS is not optional.
3. SSH in and run:

   ```bash
   sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/troppochristiano/mappify/main/deploy/setup.sh)" -- mappify.example.com
   ```

   That installs Node 22, adds swap (1 GB of RAM is not quite enough to build the
   web app), installs Caddy for automatic HTTPS, builds, and registers a systemd
   service that restarts on crash and comes back after a reboot.

4. Put your `SPOTIFY_CLIENT_ID` in `/opt/mappify/.env`, then
   `sudo systemctl restart mappify`.
5. In the Spotify dashboard, add `https://mappify.example.com/api/auth/callback`
   as a redirect URI, and add each person under **Users and Access**.

Then send people the URL. They click **Connect Spotify**, approve, and land on
their own empty globe ready to import.

```bash
sudo journalctl -u mappify -f     # logs
sudo systemctl restart mappify    # after changing .env
```

**Back up `data/`.** It holds every user's library and their refresh tokens. It
is the only thing on that machine that cannot be rebuilt.

### Running it anywhere else

The server is one Node process and needs a writable disk — that rules out
platforms with ephemeral filesystems, where every restart would delete everyone's
library. Beyond that it only wants three things set:

| variable | what it is for |
| --- | --- |
| `MAPPIFY_PUBLIC_URL` | the public `https://` address. Derives the redirect URI, and turns on the session cookie's `Secure` flag |
| `MAPPIFY_HOST` | `0.0.0.0` to accept connections from outside the machine. `127.0.0.1` otherwise, which is the default |
| `MAPPIFY_DATA` | where the per-user databases live. Defaults to `./data` |

`npm run build` then `npm start` serves the app and the API from one origin, which
is what keeps the session cookie first-party and CORS out of the picture.

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
