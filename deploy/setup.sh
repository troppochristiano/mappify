#!/usr/bin/env bash
#
# Turn a fresh Debian/Ubuntu VM into a Mappify host.
#
# Written for Google Cloud's always-free e2-micro, but nothing here is specific
# to Google — any small Linux box with a public hostname works the same way.
#
#   curl -fsSL https://raw.githubusercontent.com/<you>/mappify/main/deploy/setup.sh | bash -s -- mappify.example.com
#
# or, from a clone:  sudo bash deploy/setup.sh mappify.example.com
#
# What it does, and why each part is here:
#
#   node 22       node:sqlite is built in from 22.5, which is the whole database
#   swap          e2-micro has 1 GB of RAM and the web build wants more than that
#   caddy         terminates HTTPS with a real certificate, automatically.
#                 Spotify refuses any redirect URI that is not https unless it is
#                 loopback, so this is not optional decoration
#   systemd       Restart=always, and it comes back after the VM reboots
#
set -euo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "usage: sudo bash deploy/setup.sh <your-domain>" >&2
  echo "  the domain must already have an A record pointing at this machine" >&2
  exit 1
fi

APP_USER="${APP_USER:-mappify}"
APP_DIR="${APP_DIR:-/opt/mappify}"
REPO="${REPO:-https://github.com/troppochristiano/mappify.git}"

if [[ $EUID -ne 0 ]]; then
  echo "run this with sudo" >&2
  exit 1
fi

echo "==> packages"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates debian-keyring debian-archive-keyring apt-transport-https

echo "==> node 22"
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

# 1 GB of RAM is enough to run this and not quite enough to build the web app;
# without swap the bundler is killed by the OOM reaper halfway through, which
# looks like a random failure rather than a memory problem.
echo "==> swap"
if [[ ! -f /swapfile ]]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy
fi

echo "==> user and code"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone --depth 1 "$REPO" "$APP_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> dependencies and web build"
sudo -u "$APP_USER" npm install --prefix "$APP_DIR" --omit=dev --silent
sudo -u "$APP_USER" npm run build --prefix "$APP_DIR" --silent

# .env is never overwritten: on a second run it holds a working client id and a
# token, and clobbering those would sign everybody out to no purpose.
if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "==> .env"
  sudo -u "$APP_USER" cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  sudo -u "$APP_USER" tee -a "$APP_DIR/.env" >/dev/null <<EOF

# written by deploy/setup.sh
MAPPIFY_PUBLIC_URL=https://$DOMAIN
MAPPIFY_HOST=127.0.0.1
MAPPIFY_PORT=8787
EOF
  NEEDS_ENV=1
fi

echo "==> caddy config"
cat > /etc/caddy/Caddyfile <<EOF
# Automatic HTTPS from Let's Encrypt. Mappify itself listens on loopback only,
# so this is the single way in.
$DOMAIN {
	encode gzip zstd
	reverse_proxy 127.0.0.1:8787
}
EOF
systemctl reload caddy || systemctl restart caddy

echo "==> service"
install -m 644 "$APP_DIR/deploy/mappify.service" /etc/systemd/system/mappify.service
sed -i "s|__APP_DIR__|$APP_DIR|g; s|__APP_USER__|$APP_USER|g" /etc/systemd/system/mappify.service
systemctl daemon-reload
systemctl enable --now mappify
systemctl restart mappify

echo
echo "Mappify is running at https://$DOMAIN"
echo
if [[ "${NEEDS_ENV:-0}" == "1" ]]; then
  echo "Two things left, both by hand:"
  echo
  echo "  1. Put your Spotify client id in $APP_DIR/.env, then:"
  echo "       sudo systemctl restart mappify"
  echo
  echo "  2. At developer.spotify.com, add this redirect URI exactly:"
  echo "       https://$DOMAIN/api/auth/callback"
  echo "     and add each person's Spotify email under Users and Access."
  echo "     Development Mode allows five, and until someone is on that list"
  echo "     Spotify refuses them before they ever reach this server."
fi
echo
echo "  logs:    sudo journalctl -u mappify -f"
echo "  restart: sudo systemctl restart mappify"
echo "  backup:  $APP_DIR/data   (every library and everyone's tokens)"
