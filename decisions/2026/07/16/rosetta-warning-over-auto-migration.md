# 137. Rosetta installs get a startup warning, not an automatic arch migration

## Context

A client on an M-series Mac got the macOS 26 "Support Ending for Intel-based Apps" notice: he had installed the Intel (x64) DMG manually, Rosetta 2 ran it silently, and the in-app updater kept him on x64 forever. Electrobun's `Updater` bakes its architecture from `os.arch()` at startup (`electrobun/dist/api/shared/platform.ts`), which reports `x64` under Rosetta — all its URLs (update.json, patches, tarball) permanently target the x64 channel, with no API to override the arch.

## Investigation

`sysctl.proc_translated` is `1` only for a Rosetta-translated process; `0` on native arm64 and `0`/missing OID on real Intel Macs. An automatic cross-arch migration was fully implemented first (custom arm64 bundle download + verify + rename-aside `.app` swap + relaunch, bypassing the built-in updater — Electrobun's own download/apply pair can't be redirected because its hash lookup uses the baked arch). It worked, but replicated Electrobun's entire apply pipeline and swapped the bundle under a running process — judged too fragile to ship.

## Decision

Warn instead of migrate. `src/bun/rosetta.ts` detects Rosetta (strictly `proc_translated == 1`; real Intel Macs are never flagged) and builds a copy-pasteable reinstall command — the arm64 Homebrew cask when `/opt/homebrew/bin/brew` exists (an x86_64 Rosetta brew in `/usr/local` can't install the arm64-only cask and doesn't count), otherwise curl + open of the arm64 DMG. The `getRosettaWarning` RPC (`settings-config.ts`) feeds `RosettaWarningModal.tsx`, shown once per launch from `App.tsx`; dismissal is not persisted because the condition self-clears after reinstalling the native build. User data under `~/.dev3.0/` is untouched by the reinstall.

## Risks

The user must run the command manually — some will dismiss the modal forever (accepted: macOS shows its own escalating notice too). The brew command embeds the running bundle path at generation time; if the app moves before the user pastes it, `rm -rf` targets a stale path and brew may refuse to install over the surviving copy.

## Alternatives considered

Automatic in-updater migration (implemented, then rejected — bundle swap under a running process, duplicated Electrobun internals). Universal (fat) binaries — Electrobun can't build them and every user pays double download size forever. Upstream Electrobun patch (Rosetta-aware arch) — right long-term, doesn't help already-shipped installs. Toast instead of modal — transient and missable for an "app will stop launching" condition, and can't hold a copyable command.
