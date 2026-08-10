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

> The download is not code-signed, so the first launch needs one click past a
> warning. **Windows**: SmartScreen says "unidentified developer" — *More info* →
> *Run anyway*. **macOS**: right-click **Mappify.command** → *Open*, then *Open*.
> Once each, not every time.

No console window opens, and nothing is left behind in a terminal. Close the last
tab and Mappify stops on its own about a minute later — unless an import is still
running, in which case it finishes first. **Quit Mappify** in the library panel is
the impatient version.

It never takes over Spotify playback anywhere else, either. The token it asks for
has no playback scopes at all, and audio only plays in an embedded Spotify player
inside the tab, so your phone and the desktop app are untouched.

Your databases live in `%APPDATA%\Mappify` on Windows,
`~/Library/Application Support/Mappify` on macOS, and `$XDG_DATA_HOME/mappify` on
Linux — not next to the app, which may be somewhere unwritable.

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

### Building the Windows launcher

`Mappify.exe` is a ~300 KB Rust binary in [`launcher/`](launcher) whose whole job
is to start the Node server without a console window and make sure it cannot
outlive itself. All the behaviour is still in `tools/start.js`.

```bash
cargo build --release --manifest-path launcher/Cargo.toml
```

It needs the MSVC toolchain (Visual Studio Build Tools, "Desktop development with
C++"). Without it, `rustup toolchain install stable-x86_64-pc-windows-gnu` and
`--target x86_64-pc-windows-gnu` builds the same binary with no Visual Studio.
CI builds the MSVC one; the release workflow does this automatically.

Three things it handles that a `.bat` could not:

- **No console.** It is a windows-subsystem binary and spawns Node with
  `CREATE_NO_WINDOW`.
- **The server cannot be orphaned.** The child is assigned to a job object with
  `KILL_ON_JOB_CLOSE`, so ending the launcher — including from Task Manager —
  takes the server with it. Otherwise it would sit holding port 8787 with no
  window, and the next launch would fail for no visible reason.
- **Failures are readable.** With no console, output goes to
  `%APPDATA%\Mappify\launcher.log`, and a bad exit shows the tail of it in a
  dialog. Port 8787 already in use is the common one.

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

**It ships inside the download** — `index.db`, 63 MB, sitting next to the app. No
account, no token, no network: Spotify ends up being the only thing Mappify talks
to, which is the only one that is actually about you. A wiped library rebuilds
every place, chain and scene origin from it in **a tenth of a second**.

It holds 434,810 artists and the 16,641 areas they point at. Artist *names* are
dropped, since the app shows Spotify's own — 435,000 copies of a string nothing
reads cost 8 MB in a file people download.

The trade is staleness: it is a snapshot of MusicBrainz. An artist added after it
was built falls through to the live API, slower but working, and only for that
artist.

**Without any index** — running from source before building one — Mappify uses
the live MusicBrainz path throughout. It works, it is just slow, and the import
panel says so.

**A hosted instance** can point at a shared Turso copy instead, with
`MAPPIFY_INDEX_URL` and `MAPPIFY_INDEX_TOKEN`, which saves shipping 63 MB to a
server that could hold it once.

### Rebuilding it (maintainer)

```bash
node tools/build-mb-index.js --all      # ~1.6 GB of dumps, needs tar with xz
node tools/build-bundle-index.js        # -> data/index.db, the shippable one
gzip -9 -k data/index.db
gh release upload index data/index.db.gz --clobber
```

The release build pulls that asset and puts it in every zip, which is why the
63 MB is not in git: it is rebuilt whenever the dump is, and each rebuild
committed would be another 35 MB in the history for ever.

Worth re-running `tools/fix-artist-scenes.js` and `tools/push-derived.js` first,
so the corrections in the bundle are current.

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
