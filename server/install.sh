#!/bin/sh
# Installs one release of the daemon (run over ssh by client/client.mjs, from inside
# ~/.iro-coding/releases/r<time>/), then makes it the one new daemons start from. Running daemons are
# not touched: each keeps its own release until it hands its sessions over and exits.
set -e
REL=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$REL/../.." && pwd)
cd "$REL"
# The node that will run the daemon must be 18 or newer (the Agent SDK's minimum; an older one can't
# even parse daemon.mjs). The client shows the last line of a failed install, so that line says why.
NODE=${IRO_NODE:-node}
if ! command -v "$NODE" >/dev/null 2>&1; then
  echo "no Node on this host (\"$NODE\" is not on the login shell's PATH): install Node 18 or newer, or pass --remote-node /path/to/node" >&2; exit 1
fi
if ! "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) < 18 ? 1 : 0)'; then
  echo "this host's Node is $("$NODE" --version) ($(command -v "$NODE")), IroWell needs 18 or newer: install a newer one, or pass --remote-node /path/to/node" >&2; exit 1
fi
# Start from the packages of the release in use: npm then only fetches what changed.
if [ ! -e node_modules ] && [ -d "$ROOT/current/node_modules" ]; then cp -R "$ROOT/current/node_modules" ./node_modules; fi
npm install --omit=dev --no-audit --no-fund
# The newest Agent SDK (and so Claude Code): it doesn't update itself. Offline, keep the pinned one.
npm install --omit=dev --no-audit --no-fund @anthropic-ai/claude-agent-sdk@latest || echo "could not fetch the newest Agent SDK; keeping the pinned one" >&2
# Switch: new daemons (and the entry point the client runs) use this release from now on.
ln -sfn "releases/$(basename "$REL")" "$ROOT/current"
cp attach.mjs "$ROOT/attach.mjs.tmp" && mv -f "$ROOT/attach.mjs.tmp" "$ROOT/attach.mjs"
