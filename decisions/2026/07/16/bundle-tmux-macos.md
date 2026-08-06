# 137 — Bundle a self-contained tmux inside macOS artifacts

## Context

The tmux 3.6a pin (decision 105) was delivered only via the Homebrew keg `h0x91b/dev3/tmux@3.6`. DMG installs and the in-app updater cannot run brew, so brew-less machines (and installs that updated in-app after the keg dep was added) ended up with no usable tmux at all — the app's core feature dead on arrival. Requiring Homebrew + Command Line Tools just for tmux is a heavy ask for non-developer-adjacent users.

## Investigation

The keg binary is not copyable: `otool -L` shows absolute links into `/opt/homebrew` (libevent, ncurses, utf8proc). tmux's configure rejects fully static builds on Darwin, but a partial-static build works: libevent_core and utf8proc linked as `.a` archives, ncurses/resolv/libSystem from the OS (present on every macOS). Verified locally on arm64: the resulting 1.4 MB binary runs `new-session` under `env -i PATH=/usr/bin:/bin`. Embedding tmux bytes into the compiled Bun CLI was rejected — exec would need runtime extraction, complicating signing and quarantine.

## Decision

`scripts/build-bundled-tmux.sh` builds tmux 3.6a from sha256-pinned sources (libevent 2.1.12-stable dist tarball, utf8proc 2.11.3), native per release runner arch, `MACOSX_DEPLOYMENT_TARGET=13.0`, `PKG_CONFIG=false` so brew libs can never leak into the link; output cached in CI keyed on the script hash. `stage-bundled-tmux.sh` places it (plus license notices) into `dist/tmux/`; `sign-cli-binaries.sh` signs the helper before electrobun signs the outer bundle (same pattern as `cli/dev3`). It ships at `Contents/Resources/app/tmux/` in the app and `./tmux/` in macOS CLI tarballs (brew formula installs it into libexec). Runtime preference (`tmuxSearchPaths` in `shared-pure.ts`): custom path → bundled → keg → PATH; `selectTmuxBinary`'s live-server probe still falls back to whatever binary a running server understands. `dev3 doctor` reports the bundled binary first; release workflow gates on `otool -L` (no `/opt/homebrew`, no `/usr/local`), codesign verify, and a sanitized-PATH `new-session` smoke run. The cask drops the keg dependency; the formula keeps it **on Linux only** (Linux tarballs carry no bundled tmux — dropping it there would leave fresh installs on tmux-less boxes with nothing).

## Risks

- Existing installs with the keg keep working (bundled and keg are both 3.6a — same-version clients always talk to a live server started by either).
- Dev builds (`bun run dev`) have no bundled tmux unless the build script was run locally — dist/tmux stays an empty dir (dist/native pattern) and resolution falls through to keg/PATH.
- Compiled-in default TERM is `screen-256color` (present in every supported macOS terminfo db); dev3's own tmux config still sets its preferred `default-terminal`.
- Linux artifacts intentionally unchanged (keg/PATH resolution); bundling there is a separate effort.

## Alternatives considered

- **Keep the brew keg as the only channel** — leaves DMG/in-app-updater installs broken by design (the majority upgrade path).
- **Download tmux at first launch** — network dependency at startup, unsigned-payload and quarantine problems, another failure mode.
- **Universal (fat) binary built once** — release already runs native runners per arch; per-arch thin binaries keep the build simple and the payload smaller.
- **Commit prebuilt binaries to the repo** — opaque blobs in git history; CI source builds with pinned hashes are auditable and reproducible.
