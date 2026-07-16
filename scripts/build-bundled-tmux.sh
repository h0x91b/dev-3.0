#!/bin/bash
# Build a self-contained tmux for the macOS app bundle and CLI tarball.
#
# Why: the app pins tmux 3.6a (tmux 3.7 client busy-spin regression — see
# decisions/105-pin-tmux-3.6-vendored-keg.md), but the pin used to be delivered
# only through the Homebrew keg `h0x91b/dev3/tmux@3.6`. DMG installs and the
# in-app updater cannot run brew, so machines without Homebrew (or that
# updated in-app after the keg dep was added) had no tmux at all. This script
# produces a tmux binary that depends ONLY on libraries every macOS ships:
# libevent_core and utf8proc are statically linked; ncurses, resolv and
# libSystem come from the OS. See decisions/137-bundle-tmux-macos.md.
#
# Output: vendor/bundled-tmux/
#   tmux                      — native binary for the HOST arch (arm64 or x64)
#   licenses/…                — third-party license notices (tmux, libevent,
#                               utf8proc) + NOTICE manifest with pinned versions
#
# Usage: bash scripts/build-bundled-tmux.sh [--force]
#   Skips the build when vendor/bundled-tmux/tmux already exists and passes
#   verification (so a CI cache restore makes this step a no-op). `--force`
#   rebuilds from scratch.
#
# macOS only; exits 0 without output elsewhere (Linux keeps keg/PATH tmux).
# The release workflow runs this natively on both arm64 and Intel runners, so
# each artifact carries the matching native binary — no universal build needed.

set -euo pipefail

# ── pinned sources ──────────────────────────────────────────────────────────
# tmux pin mirrors the h0x91b/dev3/tmux@3.6 tap formula. libevent uses the
# official *dist* tarball (ships ./configure — no autotools bootstrap needed);
# utf8proc builds with its plain Makefile. Bump hashes and versions together.
TMUX_VERSION="3.6a"
TMUX_URL="https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz"
TMUX_SHA256="b6d8d9c76585db8ef5fa00d4931902fa4b8cbe8166f528f44fc403961a3f3759"

LIBEVENT_VERSION="2.1.12-stable"
LIBEVENT_URL="https://github.com/libevent/libevent/releases/download/release-${LIBEVENT_VERSION}/libevent-${LIBEVENT_VERSION}.tar.gz"
LIBEVENT_SHA256="92e6de1be9ec176428fd2367677e61ceffc2ee1cb119035037a27d346b0403bb"

UTF8PROC_VERSION="2.11.3"
UTF8PROC_URL="https://github.com/JuliaStrings/utf8proc/archive/refs/tags/v${UTF8PROC_VERSION}.tar.gz"
UTF8PROC_SHA256="abfed50b6d4da51345713661370290f4f4747263ee73dc90356299dfc7990c78"

# Oldest macOS the app supports (cask: depends_on macos: :ventura).
MACOS_MIN="13.0"

OUT_DIR="vendor/bundled-tmux"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

if [ "$(uname)" != "Darwin" ]; then
  exit 0
fi

log() { echo "[build-bundled-tmux] $*"; }

# ── verification (also used for the skip-if-cached fast path) ───────────────
verify_output() {
  local bin="$OUT_DIR/tmux"
  [ -f "$bin" ] || { log "verify: $bin missing"; return 1; }

  # Acceptance gate: no Homebrew / local-prefix dylib references — the binary
  # must run on a machine that has neither Homebrew nor Command Line Tools.
  local links
  links=$(otool -L "$bin")
  echo "$links"
  if echo "$links" | grep -Eq "/opt/homebrew|/usr/local"; then
    log "verify FAILED: otool -L shows non-system library references"
    return 1
  fi

  # Smoke: -V and a real session under a sanitized PATH/env (simulates a clean
  # machine where only OS binaries exist and no HOME dotfiles interfere).
  local smoke_home smoke_sock
  smoke_home=$(mktemp -d)
  smoke_sock="$smoke_home/smoke.sock"
  local run=(env -i HOME="$smoke_home" PATH="/usr/bin:/bin:/usr/sbin:/sbin" TERM=xterm-256color LANG=en_US.UTF-8)
  "${run[@]}" "$bin" -V | grep -q "tmux ${TMUX_VERSION}" || { log "verify FAILED: tmux -V mismatch"; return 1; }
  "${run[@]}" "$bin" -S "$smoke_sock" -f /dev/null new-session -d -s smoke || { log "verify FAILED: new-session"; return 1; }
  "${run[@]}" "$bin" -S "$smoke_sock" list-sessions | grep -q "^smoke:" || { log "verify FAILED: list-sessions"; return 1; }
  "${run[@]}" "$bin" -S "$smoke_sock" kill-server || true
  rm -rf "$smoke_home"

  for lic in tmux libevent utf8proc; do
    [ -s "$OUT_DIR/licenses/${lic}.LICENSE" ] || { log "verify FAILED: licenses/${lic}.LICENSE missing"; return 1; }
  done
  [ -s "$OUT_DIR/licenses/NOTICE" ] || { log "verify FAILED: licenses/NOTICE missing"; return 1; }

  log "verify OK: $bin ($("$bin" -V)) for $(uname -m)"
}

if [ "$FORCE" -eq 0 ] && [ -f "$OUT_DIR/tmux" ]; then
  if verify_output; then
    log "already built — skipping (use --force to rebuild)"
    exit 0
  fi
  log "existing output failed verification — rebuilding"
fi

command -v cc >/dev/null 2>&1 || { log "ERROR: no C compiler (install Xcode or Command Line Tools on the build machine)"; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
DEPS="$WORK/deps"
mkdir -p "$DEPS/lib" "$DEPS/include"

fetch() {
  local url="$1" sha="$2" out="$3"
  log "fetching $url"
  curl -fsSL --retry 3 "$url" -o "$out"
  local got
  got=$(shasum -a 256 "$out" | awk '{print $1}')
  if [ "$got" != "$sha" ]; then
    log "ERROR: sha256 mismatch for $url"
    log "  expected: $sha"
    log "  got:      $got"
    exit 1
  fi
}

# ── hermetic build environment ──────────────────────────────────────────────
# PKG_CONFIG=false forces every PKG_CHECK_MODULES to use the explicit *_CFLAGS
# / *_LIBS we pass (or fall back to AC_SEARCH_LIBS against the SDK), so a
# Homebrew libevent/ncurses on the build machine can never leak into the link.
export MACOSX_DEPLOYMENT_TARGET="$MACOS_MIN"
export PKG_CONFIG=false
unset PKG_CONFIG_PATH PKG_CONFIG_LIBDIR CPATH LIBRARY_PATH
BUILD_CFLAGS="-O2 -mmacosx-version-min=${MACOS_MIN}"

NPROC=$(sysctl -n hw.ncpu)

# ── libevent (static, core only is consumed) ────────────────────────────────
fetch "$LIBEVENT_URL" "$LIBEVENT_SHA256" "$WORK/libevent.tar.gz"
tar xzf "$WORK/libevent.tar.gz" -C "$WORK"
(
  cd "$WORK/libevent-${LIBEVENT_VERSION}"
  ./configure --prefix="$DEPS" --disable-shared --enable-static \
    --disable-openssl --disable-libevent-regress --disable-samples \
    --disable-debug-mode \
    CFLAGS="$BUILD_CFLAGS" >/dev/null
  make -j"$NPROC" >/dev/null
  make install >/dev/null
)
cp "$WORK/libevent-${LIBEVENT_VERSION}/LICENSE" "$WORK/libevent.LICENSE"

# ── utf8proc (static via its plain Makefile) ────────────────────────────────
fetch "$UTF8PROC_URL" "$UTF8PROC_SHA256" "$WORK/utf8proc.tar.gz"
tar xzf "$WORK/utf8proc.tar.gz" -C "$WORK"
(
  cd "$WORK/utf8proc-${UTF8PROC_VERSION}"
  make -j"$NPROC" CFLAGS="$BUILD_CFLAGS" libutf8proc.a >/dev/null
  cp libutf8proc.a "$DEPS/lib/"
  cp utf8proc.h "$DEPS/include/"
)
cp "$WORK/utf8proc-${UTF8PROC_VERSION}/LICENSE.md" "$WORK/utf8proc.LICENSE"

# ── tmux ────────────────────────────────────────────────────────────────────
fetch "$TMUX_URL" "$TMUX_SHA256" "$WORK/tmux.tar.gz"
tar xzf "$WORK/tmux.tar.gz" -C "$WORK"
(
  cd "$WORK/tmux-${TMUX_VERSION}"
  # Static archives passed as literal paths — nothing for the linker to
  # resolve dynamically. ncurses/resolv come from the macOS SDK via
  # AC_SEARCH_LIBS (system dylibs, present on every install).
  # --with-TERM=screen-256color: compiled-in default TERM that exists in
  # /usr/share/terminfo on every supported macOS (the tmux-256color entry is
  # missing pre-Sonoma; dev3's own config still sets its preferred value).
  ./configure --enable-utf8proc --enable-sixel --with-TERM=screen-256color \
    LIBEVENT_CORE_CFLAGS="-I$DEPS/include" \
    LIBEVENT_CORE_LIBS="$DEPS/lib/libevent_core.a" \
    LIBUTF8PROC_CFLAGS="-I$DEPS/include" \
    LIBUTF8PROC_LIBS="$DEPS/lib/libutf8proc.a" \
    CFLAGS="$BUILD_CFLAGS" >/dev/null
  make -j"$NPROC" >/dev/null
)
cp "$WORK/tmux-${TMUX_VERSION}/COPYING" "$WORK/tmux.LICENSE"

# ── stage output ────────────────────────────────────────────────────────────
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/licenses"
cp "$WORK/tmux-${TMUX_VERSION}/tmux" "$OUT_DIR/tmux"
chmod 0755 "$OUT_DIR/tmux"
cp "$WORK/tmux.LICENSE" "$WORK/libevent.LICENSE" "$WORK/utf8proc.LICENSE" "$OUT_DIR/licenses/"
cat > "$OUT_DIR/licenses/NOTICE" <<EOF
Bundled tmux for dev-3.0 (macOS $(uname -m))

tmux ${TMUX_VERSION} (ISC) — https://tmux.github.io/
  statically linked with:
  - libevent ${LIBEVENT_VERSION} (BSD-3-Clause, libevent_core only) — https://libevent.org/
  - utf8proc ${UTF8PROC_VERSION} (MIT + Unicode data license) — https://juliastrings.github.io/utf8proc/
  system libraries: ncurses, resolv, libSystem (provided by macOS).

Full license texts are in this directory.
EOF

verify_output || { log "ERROR: freshly built tmux failed verification"; exit 1; }
log "done: $OUT_DIR/tmux"
