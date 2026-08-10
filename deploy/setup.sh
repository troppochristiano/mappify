#!/usr/bin/env bash
#
# Turn a machine into a Mappify host. One command, no domain required.
#
#   sudo bash deploy/setup.sh
#
# Works on any Debian or Ubuntu box: a free Google Cloud e2-micro, an old laptop,
# a Raspberry Pi, a NAS. Spotify refuses any redirect URI that is not https
# unless it is loopback, so a public host needs a real certificate — and buying a
# domain, pointing DNS at it and waiting for a certificate is most of the work in
# every guide to this. Tailscale Funnel gives a permanent https://….ts.net
# address with a real certificate and no domain at all, so that is the default.
#
# If you would rather use your own domain:
#
#   sudo bash deploy/setup.sh mappify.example.com
#
# which installs Caddy instead and gets a Let's Encrypt certificate. It needs an
# A record already pointing at this machine.
#
set -euo pipefail

DOMAIN="${1:-}"
APP_USER="${APP_USER:-mappify}"
APP_DIR="${APP_DIR:-/opt/mappify}"
REPO="${REPO:-https://github.com/troppochristiano/mappify.git}"
PORT=8787

[[ $EUID -eq 0 ]] || { echo "run this with sudo" >&2; exit 1; }

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "packages"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg

say "node 22"
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi

# 1 GB of RAM is enough to run this and not quite enough to build the web app.
# Without swap the bundler is killed by the OOM reaper part way through, which
# reads as a random failure rather than as a memory problem.
say "swap"
if [[ ! -f /swapfile ]] && [[ "$(free -m | awk '/^Mem:/{print $2}')" -lt 2000 ]]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "code"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
if [[ -d "$APP_DIR/.git" ]]; then git -C "$APP_DIR" pull --ff-only; else git clone --depth 1 "$REPO" "$APP_DIR"; fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

say "dependencies and web build"
sudo -u "$APP_USER" npm install --prefix "$APP_DIR" --omit=dev --silent
sudo -u "$APP_USER" npm run build --prefix "$APP_DIR" --silent

# ---------------------------------------------------------------- public address
if [[ -n "$DOMAIN" ]]; then
  say "caddy for $DOMAIN"
  if ! command -v caddy >/dev/null; then
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy
  fi
  printf '%s {\n\tencode gzip zstd\n\treverse_proxy 127.0.0.1:%s\n}\n' "$DOMAIN" "$PORT" \
    > /etc/caddy/Caddyfile
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  PUBLIC_URL="https://$DOMAIN"
else
  say "tailscale"
  command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh >/dev/null

  # `tailscale up` needs a human to approve the machine in a browser. It prints
  # the link and waits, which is the one step that cannot be automated — it is
  # the authentication.
  if ! tailscale status >/dev/null 2>&1; then
    echo
    echo "  Open the link below and sign in (a Google or GitHub account is enough)."
    echo
    tailscale up --hostname=mappify
  fi

  FQDN="$(tailscale status --json | grep -o '"DNSName": *"[^"]*"' | head -1 | cut -d'"' -f4)"
  FQDN="${FQDN%.}"
  [[ -n "$FQDN" ]] || { echo "could not read the tailscale hostname" >&2; exit 1; }
  PUBLIC_URL="https://$FQDN"
fi

# ------------------------------------------------------------------------ config
# Never overwritten: on a second run it holds a working client id, and clobbering
# that would sign everybody out to no purpose.
if [[ ! -f "$APP_DIR/.env" ]]; then
  sudo -u "$APP_USER" cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  FIRST_RUN=1
fi
sudo -u "$APP_USER" sed -i \
  -e "s|^MAPPIFY_PUBLIC_URL=.*|MAPPIFY_PUBLIC_URL=$PUBLIC_URL|" \
  -e "s|^MAPPIFY_HOST=.*|MAPPIFY_HOST=127.0.0.1|" \
  "$APP_DIR/.env"
grep -q '^MAPPIFY_PORT=' "$APP_DIR/.env" || echo "MAPPIFY_PORT=$PORT" | sudo -u "$APP_USER" tee -a "$APP_DIR/.env" >/dev/null

say "service"
install -m 644 "$APP_DIR/deploy/mappify.service" /etc/systemd/system/mappify.service
sed -i "s|__APP_DIR__|$APP_DIR|g; s|__APP_USER__|$APP_USER|g" /etc/systemd/system/mappify.service
systemctl daemon-reload
systemctl enable --now mappify >/dev/null 2>&1 || true
systemctl restart mappify

# Funnel is what makes the ts.net address reachable from outside the tailnet, so
# it goes on after the service is actually listening.
if [[ -z "$DOMAIN" ]]; then
  say "opening it to the internet"
  tailscale funnel --bg "$PORT" >/dev/null 2>&1 || tailscale funnel --bg "$PORT"
fi

cat <<EOF

  Mappify is at  $PUBLIC_URL

  Two things left, both by hand and both quick:

  1. At developer.spotify.com/dashboard, open your app and add this
     redirect URI, exactly:

       $PUBLIC_URL/api/auth/callback

     Then under Users and Access, add the Spotify email of everyone who
     will use it. Five is the limit, and until someone is on that list
     Spotify turns them away before they ever reach this machine.

EOF

if [[ "${FIRST_RUN:-0}" == "1" ]]; then
cat <<EOF
  2. Put your Spotify client id in $APP_DIR/.env, then:

       sudo systemctl restart mappify

EOF
else
cat <<EOF
  2. Nothing — your .env was already set up.

EOF
fi

cat <<EOF
  logs:    sudo journalctl -u mappify -f
  restart: sudo systemctl restart mappify
  update:  sudo bash $APP_DIR/deploy/setup.sh
  backup:  $APP_DIR/data   — every library and everyone's tokens

EOF
