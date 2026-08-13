# PR origin-task deep link + https open page

## Context

PRs dev3 opens had no way back to the task that produced them. We already have
the `dev3://task/<id>` scheme (decision 144), but a bare `dev3://` link pasted
into a PR body is not clickable: GitHub's markdown sanitizer keeps only
http(s)/mailto links, so a custom scheme renders as inert text.

## Decision

The PR handoff prompt (`createPrAgentPrompt` in `src/bun/rpc-handlers/git-operations.ts`)
now instructs the agent to append a deep-link footer verbatim to the PR
description. The footer is built by `buildTaskPrDeepLinkSection` in
`src/shared/deep-link.ts` — one source of truth — and carries **both** a
clickable `https://dev3.h0x91b.com/open.html?task=<id>` link and the raw
`dev3://task/<id>` in a code span. The https link points at a new static page,
`docs/open.html` (served from the existing GitHub Pages domain), which reads the
query params, rebuilds the `dev3://` URL and redirects to it — the "https open
page" the 144 record said could layer on later without changing the grammar.

## Risks

- **Agent compliance.** The footer arrives as a prompt instruction, like the
  rest of the PR title/description handoff, so a misbehaving agent could omit it.
  Acceptable — consistent with how the whole PR handoff already works.
- **Page-deploy lag.** If `open.html` is not yet deployed, the https link 404s;
  the raw `dev3://` fallback in the same footer still works once dev3 is installed.
- **Non-macOS / task not local.** The scheme is macOS-only and resolves only on a
  machine that has the task; elsewhere the open is ignored quietly. No data leak —
  the id is opaque and `resolveDeepLink` returns null for unknown ids.

## Alternatives considered

- **Raw `dev3://` only.** Simplest, but not clickable in a PR — poor UX.
- **A settings toggle.** Deferred here, then **un-deferred by issue #1340** — a
  public PR would otherwise advertise dev3 usage. Now a default-on
  `GlobalSettings.prOriginTaskLink`; see
  [pr-deeplink-optout-and-fixes](pr-deeplink-optout-and-fixes.md).
- **Full Universal Links** (apple-app-site-association + notarization). Overkill;
  the client-side redirect page gives the clickable-link win without that wiring.
