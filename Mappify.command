#!/usr/bin/env bash
# Double-click this to start Mappify. (macOS and Linux.)
#
# .command is the extension macOS opens in Terminal on a double-click. Linux
# desktops generally offer "Run in Terminal" for the same file.
#
# The first launch on macOS is refused by Gatekeeper, because this was
# downloaded rather than written here: right-click it and choose Open, and the
# dialog gains an Open button. That is once, not every time.

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
