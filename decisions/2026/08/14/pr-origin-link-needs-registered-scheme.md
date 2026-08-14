# The PR origin-task deep link ships only where the scheme is registered

## Context

"Link pull requests back to the task" (Global Settings → Tasks & Board) makes the
Create-PR handoff ask the agent to end a **public** PR description with
`https://dev3.h0x91b.com/open.html?task=<id>` plus the raw `dev3://task/<id>`. The
https page exists only to bounce the reader into the `dev3://` scheme.

## Investigation

Scheme registration is `CFBundleURLTypes`, written by Electrobun into the macOS
`Info.plist`. `vendor-docs/electrobun/apis/cli/build-configuration.md` ("Platform
Support") and `apis/events.md` (`open-url`) both state **Windows and Linux: not yet
supported**, and the repo carries no registry write and no xdg-mime registration
either. So off macOS the footer publishes a link that resolves to nothing for whoever
clicks it — worse than no footer, because it is other people's eyes on a dead link in
a public PR.

## Decision

`deepLinkSchemeRegistered(platform)` in `src/shared/deep-link.ts` is true only on
`darwin`. It landed in `main` from the sibling task that gated the agent-skill text
(`skillPrLinkInstruction`); this change adds two more consumers rather than a second
copy of the predicate:

- `createPullRequest` (`src/bun/rpc-handlers/git-operations.ts`) drops the footer line
  before the stored preference is even consulted.
- The toggle in `BehaviorSettingsSection.tsx` renders **Off and disabled** with a
  `text-warning` line saying why, fed by the `checkPrOriginTaskLinkSupported` RPC
  (host-side, mirroring `checkCanaryChannelAvailable` — browser-side platform sniffing
  would answer for the machine holding the browser).

**The stored value is never rewritten.** `settings.json` may travel to a machine where
the feature works, so the gate is on behaviour and on the control, never on disk
(`AGENTS.md`, "On-disk data layout — hard invariants").

**Capability, not OS list.** The predicate is named for the fact it tests. The day a
platform registers the scheme — Electrobun on Windows, or dev3 writing a
`HKCU\Software\Classes\dev3` key / an xdg-mime entry itself — that platform is added
here and everything downstream follows. Nothing else changes.

## Risks

- **Linux users who have the setting on today lose the footer.** That is a live
  behaviour change for them, not a no-op, and it was chosen with that cost stated:
  the alternative was leaving Linux publishing links that do not resolve.
- **The agent path is gated separately, by `skillPrLinkInstruction`.** The two gates
  must agree: an agent told to append a footer that `createPullRequest` then omits
  (or the reverse) is worse than either alone. They share this one predicate precisely
  so they cannot drift.

## Alternatives considered

- **Gate Windows only.** The original ask, and what this task first shipped. Rejected
  on review: Linux has no registration either, so dev3 would have kept publishing dead
  links there while telling agents not to.
- **Force `prOriginTaskLink: false` on disk at load.** Rejected: a destructive
  migration of user state, banned outright, and it would disarm the setting on the
  user's macOS machine too if the file is shared.
- **Hide the control off macOS.** Rejected: a control that vanishes reads as a bug;
  the manifest's own rule (`PRODUCT_UX_BIBLE.md`, feature-gated preset) is
  keep-visible-but-disabled with the reason spelled out.
- **Sniff the platform in the renderer.** Rejected: in remote/browser mode that answers
  for the phone, not for the host that opens the PR.
