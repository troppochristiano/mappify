#!/usr/bin/env bash
# Double-click this to start Mappify. (Linux.)
#
# Linux desktops offer "Run in Terminal" for this file, and Mappify.desktop
# beside it runs the same script from a file manager or an application menu.
#
# macOS used to be the other half of this file's job — .command is the extension
# it opens in Terminal — and now ships a Mappify.app instead: a bundle can carry
# an icon and a name, start without a Terminal window behind it, and be dragged
# to Applications without leaving its own parts behind. See mac/Mappify.app.
#
# Kept working on macOS all the same, because a checkout is not a download: it
# is still the shortest way to start the app from a clone.

cd "$(dirname "$0")"

# A bundled runtime sits in ./runtime when this came from a release zip.
if [[ -x "runtime/bin/node" ]]; then
  NODE="runtime/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE="node"
else
  echo
  echo "  Mappify needs Node.js, which is a free download."
  echo "  Opening nodejs.org — install the LTS version, then run this again."
  echo
  (command -v open >/dev/null && open https://nodejs.org) || \
    (command -v xdg-open >/dev/null && xdg-open https://nodejs.org) || true
  read -r -p "  Press return to close."
  exit 1
fi

echo
echo "  Starting Mappify. Leave this window open while you use it."
echo "  Close it, or press Ctrl-C, to stop."
echo

"$NODE" tools/start.js

echo
echo "  Mappify stopped."
read -r -p "  Press return to close."
