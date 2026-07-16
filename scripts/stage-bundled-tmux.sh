#!/bin/bash
# Stage the bundled tmux (built by scripts/build-bundled-tmux.sh into
# vendor/bundled-tmux/) into dist/tmux/ so the electrobun.config.ts copy rule
# ("dist/tmux" → Resources/app/tmux) and the CLI tarball can pick it up.
#
# Mirrors the dist/native pattern: the directory is ALWAYS created so the copy
# rule has a source; it stays empty on Linux and on dev machines that never
# ran the (slow) tmux build — the app then falls back to the Homebrew keg /
# PATH resolution tiers at runtime.

set -euo pipefail

mkdir -p dist/tmux

if [ -f vendor/bundled-tmux/tmux ]; then
  rm -rf dist/tmux
  mkdir -p dist/tmux
  cp -R vendor/bundled-tmux/. dist/tmux/
  echo "[stage-bundled-tmux] staged: dist/tmux/tmux ($(dist/tmux/tmux -V 2>/dev/null || echo 'version probe failed'))"
else
  echo "[stage-bundled-tmux] vendor/bundled-tmux/tmux absent — dist/tmux stays empty (keg/PATH fallback at runtime)"
fi
