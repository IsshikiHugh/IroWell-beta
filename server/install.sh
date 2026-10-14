#!/bin/sh
# Installs one release of the daemon (run over ssh by client/client.mjs, from inside
# ~/.iro-coding/releases/r<time>/). Running daemons are not touched: each keeps its own release until it
# hands its sessions over and exits.
set -e
REL=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$REL/../.." && pwd)
cd "$REL"
# A failed install leaves nothing behind: its release folder holds a copy of every package (~300 MB), and a
# failed update is tried again, and again. (Only a release folder: never a checkout's server/.)
trap 'status=$?; case "$REL" in "$ROOT"/releases/r[0-9]*) [ $status -eq 0 ] || { cd "$ROOT" && rm -rf "$REL"; };; esac' EXIT
# The node that will run the daemon must be 18 or newer (the Agent SDK's minimum; an older one can't
# even parse daemon.mjs). The client shows the last line of a failed install, so that line says why.
NODE=${IRO_NODE:-node}
if ! command -v "$NODE" >/dev/null 2>&1; then
  echo "no Node on this host (\"$NODE\" is not on the login shell's PATH): install Node 18 or newer, or pass --remote-node /path/to/node" >&2; exit 1
fi
if ! "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) < 18 ? 1 : 0)'; then
  echo "this host's Node is $("$NODE" --version) ($(command -v "$NODE")), IroWell needs 18 or newer: install a newer one, or pass --remote-node /path/to/node" >&2; exit 1
fi
packages() {
  npm install --omit=dev --no-audit --no-fund
  # The newest Agent SDK (and so Claude Code): it doesn't update itself. Offline, keep the pinned one.
  npm install --omit=dev --no-audit --no-fund @anthropic-ai/claude-agent-sdk@latest || echo "could not fetch the newest Agent SDK; keeping the pinned one" >&2
}
# Start from the packages of the release in use: npm then only fetches what changed.
if [ ! -e node_modules ] && [ -d "$ROOT/current/node_modules" ]; then cp -R "$ROOT/current/node_modules" ./node_modules; fi
packages
# Claude Code must run. Its ~250 MB binary can come out of a copy damaged with no error from cp or npm (on an
# NFS home, 4 MB of one came out as zeros, and every session then failed), and npm, which only compares
# version numbers, would never fetch it again. So a release whose Claude Code doesn't run gets its packages
# again from scratch, and if it still doesn't run, the install fails with why.
if ! "$NODE" daemon.mjs --check-cli; then
  echo "fetching the packages again" >&2
  rm -rf node_modules
  packages
  "$NODE" daemon.mjs --check-cli
fi
# The release new daemons start from (`current`) and the attach.mjs clients run: this one, on a host that
# has none yet (a fresh install). An update becomes them once its daemon has taken over (daemon.mjs,
# makeCurrent): a release only prepared, perhaps never switched to, must not be what a daemon started after
# a reboot, a crash or an idle exit runs.
if [ ! -e "$ROOT/current/daemon.mjs" ] || [ ! -e "$ROOT/attach.mjs" ]; then
  ln -sfn "releases/$(basename "$REL")" "$ROOT/current"
  cp attach.mjs "$ROOT/attach.mjs.tmp" && mv -f "$ROOT/attach.mjs.tmp" "$ROOT/attach.mjs"
fi
