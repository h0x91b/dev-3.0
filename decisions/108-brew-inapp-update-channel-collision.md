# 108 — Survive the brew / in-app updater channel collision

## Context

The app ships through two channels: the Homebrew cask and the in-app Electrobun updater. In-app updates swap the `.app` bundle without brew's knowledge, so the Caskroom-recorded version drifts behind the installed bundle. A later bulk `brew upgrade` then "upgrades" the cask: it removes `/Applications/dev-3.0.app` mid-dance and can fail before installing the new one (`Directory not empty`, "already an App at…"). Worse, the running instance's cwd is *inside* the bundle (`Contents/MacOS`), so once the bundle is ripped away every `spawn()` without an explicit `cwd` dies with ENOENT (posix_spawn resolves the child's cwd from the parent's) — tmux spawns fail while git spawns (explicit cwd) keep working. Verified live via `lsof -d cwd` on a broken instance.

## Decision

Two-sided fix:

1. **App**: `process.chdir(DEV3_HOME)` early in `src/bun/index.ts`, right after the startup log lines. Safe there because electrobun's `dlopen(join(process.cwd(), "libNativeWrapper.dylib"))` runs at module import (`electrobun/dist/api/bun/proc/native.ts`), i.e. before our module body. After this, a ripped-away bundle can no longer kill child spawns.
2. **Cask**: `auto_updates true` in the cask (release.yml heredoc — the source of truth — plus a direct push to the live tap so existing users are protected before the next release). Bulk `brew upgrade` now skips dev3; an explicit `brew upgrade --cask dev3` still upgrades (brew passes `greedy: true` for explicitly named casks — `Library/Homebrew/cask/upgrade.rb`). Also switched `depends_on macos:` to the bare-symbol form (string comparison format is deprecated and warns on every brew command; bare symbol parses with `comparator: ">="`).

No reproduction test: the bug requires deleting a live `.app` bundle from under a running process; `index.ts` is bootstrap code excluded from coverage.

## Risks

- Anything relying on cwd being the bundle would break — audited: the only cwd-relative consumers in the process are electrobun's dlopen (runs before the chdir) and `git.ts` clone (uses cwd as a neutral base; DEV3_HOME is strictly safer than a deletable bundle path).
- `auto_updates` hides dev3 from bulk `brew upgrade`/`brew outdated` — intended; the in-app updater is the primary channel. Users who consciously track via brew must name the cask explicitly or pass `--greedy`.

## Alternatives considered

- **Explicit `cwd` on every spawn call**: fragile — any future spawn without one silently reintroduces the bug; chdir fixes the class.
- **Syncing Caskroom metadata from the in-app updater**: writing into brew's private state from the app is brittle across brew versions and installs where brew was never used.
