# 108 — Survive the brew / in-app updater channel collision

> **Superseded in part by [110](110-no-chdir-pin-child-cwd.md).** The `process.chdir(DEV3_HOME)`
> piece of this decision (Decision item 1) was wrong and has been reverted: it
> blanked the desktop window because electrobun resolves the `views://` protocol
> (the renderer) relative to `process.cwd()` at window creation, *after* the chdir.
> The ENOENT hazard is now handled by defaulting the child cwd in `src/bun/spawn.ts`
> — the process no longer chdirs. **The cask half (item 2, `auto_updates` + the
> `depends_on macos:` fix) still stands and shipped.** The struck-through text below
> is kept for the historical record.

## Context

The app ships through two channels: the Homebrew cask and the in-app Electrobun updater. In-app updates swap the `.app` bundle without brew's knowledge, so the Caskroom-recorded version drifts behind the installed bundle. A later bulk `brew upgrade` then "upgrades" the cask: it removes `/Applications/dev-3.0.app` mid-dance and can fail before installing the new one (`Directory not empty`, "already an App at…"). Worse, the running instance's cwd is *inside* the bundle (`Contents/MacOS`), so once the bundle is ripped away every `spawn()` without an explicit `cwd` dies with ENOENT (posix_spawn resolves the child's cwd from the parent's) — tmux spawns fail while git spawns (explicit cwd) keep working. Verified live via `lsof -d cwd` on a broken instance.

## Decision

Two-sided fix:

1. ~~**App**: `process.chdir(DEV3_HOME)` early in `src/bun/index.ts`, right after the startup log lines. Safe there because electrobun's `dlopen(join(process.cwd(), "libNativeWrapper.dylib"))` runs at module import (`electrobun/dist/api/bun/proc/native.ts`), i.e. before our module body. After this, a ripped-away bundle can no longer kill child spawns.~~ **Reverted — see [110](110-no-chdir-pin-child-cwd.md).** The "safe" claim was wrong: `dlopen` does run before the chdir, but electrobun resolves the `views://` renderer protocol relative to `process.cwd()` at *window creation* (after the chdir), so the desktop window loaded blank. Replaced by defaulting the child cwd to `DEV3_HOME` in `src/bun/spawn.ts` while the process stays in the bundle.
2. **Cask**: `auto_updates true` in the cask (release.yml heredoc — the source of truth — plus a direct push to the live tap so existing users are protected before the next release). Bulk `brew upgrade` now skips dev3; an explicit `brew upgrade --cask dev3` still upgrades (brew passes `greedy: true` for explicitly named casks — `Library/Homebrew/cask/upgrade.rb`). Also switched `depends_on macos:` to the bare-symbol form (string comparison format is deprecated and warns on every brew command; bare symbol parses with `comparator: ">="`).

No reproduction test for the cask change: it lives in the release.yml heredoc / tap.

## Risks

- `auto_updates` hides dev3 from bulk `brew upgrade`/`brew outdated` — intended; the in-app updater is the primary channel. Users who consciously track via brew must name the cask explicitly or pass `--greedy`.
- ~~Anything relying on cwd being the bundle would break — audited: the only cwd-relative consumers in the process are electrobun's dlopen (runs before the chdir) and `git.ts` clone.~~ **This audit was incomplete and wrong** — it missed electrobun's `views://` resolution, which is why the chdir was reverted (see [110](110-no-chdir-pin-child-cwd.md)). Lesson: a grep for `process.cwd()` in `node_modules/electrobun` does not surface cwd-relative resolution that happens native-side; any change to the startup sequence needs a packaged-desktop smoke test, not just CLI + unit tests.

## Alternatives considered

- **Pin the child cwd in the spawn wrapper instead of chdir-ing the process**: initially rejected here as "any future spawn without an explicit cwd silently reintroduces the bug" — but this turned out to be the *correct* fix (all app spawns route through `spawn.ts`, which now defaults the cwd). See [110](110-no-chdir-pin-child-cwd.md).
- **Syncing Caskroom metadata from the in-app updater**: writing into brew's private state from the app is brittle across brew versions and installs where brew was never used.
