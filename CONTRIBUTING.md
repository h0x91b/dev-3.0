# Contributing to dev-3.0

Thanks for contributing! The deep reference is [`AGENTS.md`](AGENTS.md) — it is written for AI coding agents working inside dev3 worktrees, but every rule in it applies to human contributors too. This file is the short path in: setup, the rules PRs most often bounce on, and what to expect from review. Where this file adds something AGENTS.md does not say, it is about the contribution process, not about the code.

## Setup

You need [Bun](https://bun.sh), git, and **tmux 3.6 or newer** — every task terminal runs inside tmux, so an older or missing tmux gives you broken terminals with no visible explanation. Per-platform versions and the build-from-source path: [`docs/install.md`](docs/install.md).

```bash
bun install
bun run dev       # build, package, launch locally (no HMR/watch flow — this is the only dev loop)
bun run lint      # TypeScript type-check
bun run test      # fast subset: renderer + backend + CLI, minus the slow e2e suites (~6s)
bun run test:full # what CI runs — use this before opening a PR (~42s)
```

## Before opening a PR

The [pull request template](.github/pull_request_template.md) is the checklist; these are the rules behind its most-bounced items:

- **Changelog entry, dated to the day you write it.** Every code change ships one file under `change-logs/YYYY/MM/DD/<type>-<slug>.md` — `YYYY/MM/DD` is the day you create the entry. Leave it there: no need to move it when the PR merges later. Format spec: [`change-logs/README.md`](change-logs/README.md).
- **Decision records — write them, and keep old ones honest.** Non-obvious choices, workarounds, and reverse-engineered behavior go in `decisions/YYYY/MM/DD/<slug>.md` (never numbered). If your change makes an **existing** record's claims false, add a supersede note to it pointing at a new record in the same commit — see [`decisions/README.md`](decisions/README.md).
- **Full verification, not partial.** Before the PR: `bun run lint` clean and `bun run test:full` green. Sibling test files assert against the same components, so running only the file you edited is not sufficient — and the plain `bun run test` excludes slow e2e suites that CI does run, so a green fast run is not a green CI. Re-run after any rebase.
- **Rebase on `main` first.** `git fetch origin main && git rebase origin/main` before pushing — PRs are squash-merged and reviewed against current `main`.
- **English only in the repo.** Commit messages, comments, changelog entries, decision records, PR text.
- **i18n and design tokens.** User-facing strings go through `t()` with keys in all three locales (`en`/`ru`/`es`); colors come from the semantic token classes, never hardcoded hex/rgb.
- **No native dialogs.** The app also runs headless in a browser (`dev3 remote`) — use the in-app `confirm()` service, toasts, or a React modal.
- **Registries stay in lockstep with features.** New surface or action → `docs/ux/`; new shortcut → `src/mainview/keymap.ts`; new search token → the search help strings in `i18n/translations/*/help.ts`; non-obvious capability → consider `ask-dev3` / tips (sparingly — see AGENTS.md).
- **Pin new dependencies to an exact version.** Maintainer builds resolve packages through a mirror that can lag the npm registry, so a freshly published patch version may not install. An exact pin makes the failure visible and fixable instead of environment-dependent.
- **UI changes get manual browser QA.** A green suite does not verify a visual surface. Take screenshots in streamer mode (`&streamer=on`).

## What review looks like here

Reviews are hands-on: the reviewer typically checks out the branch, runs it, and verifies findings by measurement rather than by reading the diff. Expect concrete repro steps for anything flagged, and reciprocate — PR descriptions that say what you verified (and what you did not) get reviewed faster. Mark the PR ready (not draft) when you want a review, and don't arm auto-merge on a contributed PR — merging that one is the maintainer's call. (Maintainer-side agents working in their own worktrees follow `AGENTS.md`, which does arm it.)
