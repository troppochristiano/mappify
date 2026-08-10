# Mappify

A globe of your music. Every artist in your Spotify library is placed where they
are actually from — resolved through MusicBrainz and Wikidata, not guessed from
names — so you can spin the world, tune into a city, hear something from it, and
turn any place into a playlist.

## Run it

It runs on your own computer. Nothing to host, nothing to pay for, and your
library never leaves the machine.

**Download** the file for your computer from
[Releases](https://github.com/troppochristiano/mappify/releases), unzip it, and
open **Mappify**. Nothing to install — the runtime is inside.

> Your computer will warn you that this is from an unidentified developer, since
> the download is not code-signed. On Windows: *More info → Run anyway*. On macOS:
> right-click **Mappify.command** → *Open*, then *Open* again. Once, not
> every time.

Or from the source, if you have **Node 22+** (24 recommended: `node:sqlite` runs
unflagged):

```bash
git clone https://github.com/troppochristiano/mappify.git
cd mappify
npm start
```

Either way it opens [127.0.0.1:8787](http://127.0.0.1:8787) in your browser.

The app asks for one thing on first run: a **Spotify Client ID**. It walks you
through getting one — create an app at
[developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), paste
in the redirect URI it shows you, copy the ID back. Two minutes, free, and the
screen has a copy button for the URI, which has to match exactly.

Then click **Connect Spotify** and import.

> Why you need your own Spotify app: Spotify will not talk to an application it
> has never heard of, and since February 2026 an unreviewed app is
> *"limited to up to five authorized users"*. Running your own copy sidesteps
> that entirely — you are the developer, and you need one of your own five slots.

The slow part of placing artists on a map is already done: origins come from a
**shared index**, so a first import takes seconds rather than the twenty-odd
minutes it would cost to ask MusicBrainz artist by artist.

### Where things live

| | |
|---|---|
| `data/u_<your spotify id>.db` | your library, and your Spotify tokens |
| `data/control.db` | which accounts have signed in, and the client ID |

Back up `data/` if you have pinned any artists by hand; everything else in there
can be rebuilt by importing again.

### Developing on it

```bash
npm run dev
```

Two processes with hot reload: the API on 8787, Vite on 5273. If either port is
taken both move and the console says where — but an API on anything other than
8787 no longer matches the redirect URI you registered, and Spotify will refuse
the sign-in.

## Optional: hosting it for other people

You do not need this. Everything above works on your own machine, and sending a
friend the three commands is usually the better answer — they get their own copy,
their own five Spotify slots, and their data stays on their computer.

Host it only if you want people who will not run a terminal to be able to open a
link. Everyone still gets their own map: each account that signs in gets its own
database under `data/` and its own Spotify tokens, and nobody can see anyone
else's library. The five-account cap is per Spotify **application**, so a host
covers five people, and any other group runs their own copy for their own five.

### The whole setup

On any Debian or Ubuntu machine — an old laptop, a Raspberry Pi, a NAS, a free
cloud VM:

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/troppochristiano/mappify/main/deploy/setup.sh)"
```

It installs Node, builds the app, sets up a service that restarts on crash and
after a reboot, and puts it on the internet over HTTPS at a permanent address
like `https://mappify.your-tailnet.ts.net`.

**No domain, no DNS, no certificate, no port forwarding.** That normally accounts
for most of the work, and it exists only because Spotify refuses any redirect URI
that is not `https`. [Tailscale Funnel](https://tailscale.com/kb/1223/funnel)
provides the address and the certificate for free, so all of it disappears. The
script pauses once for you to approve the machine in a browser — that step is the
authentication, and cannot be automated.

Then, once:

1. Put your `SPOTIFY_CLIENT_ID` in `/opt/mappify/.env` and
   `sudo systemctl restart mappify`.
2. In the [Spotify dashboard](https://developer.spotify.com/dashboard), add
   `<your address>/api/auth/callback` as a redirect URI, and add each person's
   Spotify email under **Users and Access**.

Send people the URL. They click **Connect Spotify**, approve, and land on their
own empty globe, ready to import.

```bash
sudo journalctl -u mappify -f       # logs
sudo bash /opt/mappify/deploy/setup.sh   # update to the latest version
```

**Back up `/opt/mappify/data`.** It holds every user's library and their refresh
tokens, and it is the only thing on that machine that cannot be rebuilt.

#### If you already own a domain

Pass it, and the script installs Caddy and gets a Let's Encrypt certificate
instead of using Tailscale. It needs an `A` record already pointing at the
machine.

```bash
sudo bash deploy/setup.sh mappify.example.com
```

#### Always-on, for free

A home machine only serves while it is awake. For something that is always up at
no cost, Google Cloud's `e2-micro` is free forever in `us-west1`, `us-central1`
and `us-east1` — create it with **Debian 12** and a **standard persistent disk**
(the default *balanced* disk is billed), SSH in, and run the same one-liner. A
card on file is required even though nothing is charged; set a $1 budget alert
and check the cost table after a day.

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
