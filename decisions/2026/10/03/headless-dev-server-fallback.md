# `bun run dev` falls back to a headless server where the desktop window cannot open

## Context

`dev3 dev-server start` runs `bun run dev`, which ends in `electrobun dev`. On Linux that opens a
GTK window over WebKitGTK, so on a host without a display or without `libwebkit2gtk-4.1` (WSL
without WSLg, SSH, containers) the dev loop fails outright. Browser QA through `/debug-ui` then has
no branch build to open, and agents fell back to building and unpacking a CLI tarball by hand.

## Investigation

The headless server (`dev3 remote`) already serves the whole UI from a views dir. The compiled
`dist/dev3` carries no build channel, so `mayWriteManagedCli` (`src/bun/managed-cli-guard.ts`)
treats it as an install and lets it overwrite the shared `~/.dev3.0/bin/dev3`. A `bun` process
running from source is refused that write. An agent shell also inherits the installed server's
`DEV3_REMOTE_PORT`, `DEV3_VIEWS_DIR` and `DEV3_VIEWS_DIR_AUTO`.

## Decision

`scripts/dev.ts` picks a shell with `devShell`: headless when `--headless` or
`DEV3_DEV_HEADLESS=1` is given, or on Linux with no display or no `libwebkit2gtk-4.1.so.0`.
Headless builds the renderer and the worker bundles only, then runs
`bun src/cli/main.ts remote --no-detach` (`headlessCommand`) with the port, host, tunnel and views
dir pinned by `headlessRunEnv`. It defaults to the `seeded` QA scope, because the real board
usually belongs to an installed `dev3 remote`; `DEV3_QA_SCOPE=0` opts out.

## Risks

The WebKitGTK probe checks fixed library dirs; a distro that installs it elsewhere goes headless
when a window could open; `--headless` is never needed there, but there is no flag to force the window. The
headless run cannot exercise the native window, menu or OS notifications.

## Alternatives considered

- **Run the compiled `dist/dev3`.** Closest to a release, but it would take over the managed CLI.
- **A desktop/headless choice on the Dev Server button.** That button runs any project's
  `devScript`; the choice means something only in this repo, and on a host without a display
  there is nothing to choose.
- **Install WebKitGTK and WSLg.** Fixes one machine, needs root, and leaves SSH and containers
  where they were.
