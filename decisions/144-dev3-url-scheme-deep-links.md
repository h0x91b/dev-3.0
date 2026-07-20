# 144 — `dev3://` URL scheme (inbound deep links)

## Context

Users want browser/tool links that jump straight into the app, the way "Open in
Cursor / VS Code" links work. The flagship case: a link that opens the **Create
Task** modal prefilled with predefined text, so an external tool can hand a task
description to dev3 in one click.

## Decision

Register a custom URL scheme via Electrobun's `app.urlSchemes: ["dev3"]`
(`electrobun.config.ts`) — Electrobun writes `CFBundleURLTypes` into the
`Info.plist` at build time. The grammar lives in one pure module,
`src/shared/deep-link.ts` (`parseDeepLink` / `build*DeepLink`), shared by the
inbound receiver and the outbound "Copy deep link" menu action:

- `dev3://task/<taskId>`
- `dev3://project/<projectId>`
- `dev3://new-task?project=<projectId>&text=<url-encoded>`

The `open-url` event handler (`src/bun/index.ts`) parses the URL, resolves it
against on-disk data (`src/bun/deep-link.ts` → `resolveDeepLink`, verifies the
task/project exists, falls back to the first project for `new-task` links that
omit one), then navigates using the **existing** notification-click machinery:
warm path pushes `openDeepLink` to the focused window; cold path (window-less in
the dock) stashes the target in `deep-link-nav.ts` and the reopened renderer
pulls it on mount via `consumePendingDeepLinkNav` (a push would race the
not-yet-registered listener). The renderer routes task→task view,
project→board, new-task→Create Task modal prefilled via a new `initialText`
prop. "Copy deep link" sits in the task context menu (`OpenInMenu.tsx`) beside
"Copy path".

## Risks

- **macOS only.** Electrobun registers the scheme on macOS only (Windows/Linux
  unsupported); the receiver simply never fires elsewhere — no crash, the
  feature is just absent. Outbound "Copy deep link" still works everywhere but
  the copied link only resolves on macOS.
- **Requires `/Applications`.** macOS only registers `CFBundleURLTypes` for an
  app installed in `/Applications` (or `~/Applications`); `bun run dev` builds
  will not receive links. This is inherent to macOS, documented, not a bug.
- **Scheme collision.** If another app already claims `dev3://`, first-installed
  wins. `dev3` is unique enough that the risk is low.

## Alternatives considered

- **External shim → `dev3` CLI unix socket.** Register the scheme on a helper
  that shells into the CLI. Rejected: duplicates the IPC the app already has and
  adds a moving part.
- **Universal Links (`https://…/open?…`).** Nicer (plain https) but needs a
  domain-hosted apple-app-site-association file plus notarization wiring —
  overkill for the current need. Can layer on later without changing the grammar.
