#!/bin/sh
# Installs one release of the daemon (run over ssh by client/client.mjs deploy, from inside
# ~/.iro-coding/releases/r<time>/), then makes it the one new daemons start from. Running daemons are
# not touched: each keeps its own release until it hands its sessions over and exits.
set -e
REL=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$REL/../.." && pwd)
cd "$REL"
# Start from the packages of the release in use (or of the old single-folder layout): npm then only
# fetches what changed.
if [ ! -e node_modules ]; then
  if [ -d "$ROOT/current/node_modules" ]; then cp -R "$ROOT/current/node_modules" ./node_modules
  elif [ -d "$ROOT/node_modules" ]; then cp -R "$ROOT/node_modules" ./node_modules
  fi
fi
npm install --omit=dev --no-audit --no-fund
# The newest Agent SDK (and so Claude Code): it doesn't update itself. Offline, keep the pinned one.
npm install --omit=dev --no-audit --no-fund @anthropic-ai/claude-agent-sdk@latest || echo "could not fetch the newest Agent SDK; keeping the pinned one" >&2
# Switch: new daemons (and the entry point the client runs) use this release from now on.
ln -sfn "releases/$(basename "$REL")" "$ROOT/current"
cp attach.mjs "$ROOT/attach.mjs.tmp" && mv -f "$ROOT/attach.mjs.tmp" "$ROOT/attach.mjs"
