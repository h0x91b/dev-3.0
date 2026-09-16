# Review comments live on the task record, with a typed anchor per surface

## Context

The diff viewer already had Base44-style commenting for code and markdown: gutter or selection
comments, per-comment and batch `Send to agent`, an XML prompt. But the whole thing — composer,
bubble, store, serializer — was private to `TaskDiffViewer.tsx`, the store was browser
`localStorage` with a 3-day expiry, and the agent could only ever read what was pasted into its
pane. HTML artifacts, the other thing an agent produces, could not be commented on at all (the
only channel was a form the report author wired to `window.dev3.sendToAgent`). The user asked
for one model across viewers, in one PR.

## Decision

- **One model, `src/shared/review.ts`.** A `ReviewComment` is text plus a typed `anchor`:
  `diff-line` (file, side, line range) or `artifact-element` (artifact id, version, CSS path,
  element text, nearest heading). The pure mutations (`resolveReviewComment`, `markReviewCommentsSent`,
  …) are shared by the RPC handlers, the CLI socket routes and the renderer's optimistic state so
  every writer applies one rule.
- **The store is `Task.review`.** Additive field, written in place through `data.updateTaskWith`,
  one RPC per mutation (`src/bun/rpc-handlers/review-comments.ts`) so an agent resolving through
  the CLI never races a renderer edit with a whole-array write. Capped at 200 with resolved
  comments evicted first. The renderer's `useTaskReview` applies each edit locally and lets the
  `taskUpdated` push replace it. A review still in the old localStorage key is imported once on
  the next diff open (`src/mainview/review/legacy-storage.ts`), then the key is dropped.
- **The agent closes the loop.** `dev3 review list|resolve|reply|reopen` (`src/cli/commands/review.ts`,
  routes `review.*` in `cli-socket-server.ts`). The prompt footer (`buildReviewPrompt`) names those
  commands, so the agent learns them from the review itself — the skill body was 11 characters
  under the Windows command-line cap and could not take a paragraph.
- **Artifact comment mode** is a script injected into the artifact document
  (`src/mainview/utils/artifactCommentScript.ts`, authored as a function like the bridge): it
  crosshairs the frame, reports a clicked element, and draws the pins itself because only the
  frame knows its own scroll and layout. Pins the selector no longer matches are re-found by
  heading + text and otherwise reported back as unmatched — shown as outdated, never dropped.
- **Ids are UUIDs.** The previous path-derived ids (`src/a.ts:newFile:1:…`) had useless
  8-character prefixes for a CLI that resolves prefixes.

## Risks

- `tasks.json` grows by the review; the 200-cap bounds it. Older app versions ignore the field.
- The diff viewer's send marks comments sent on a resolved RPC as before; nothing new is deleted on
  send (`decisions/2026/08/10/never-destroy-a-review-on-send.md` still holds).
- A comment made from a popup viewer whose task is not on screen has no live record to sync from
  until the task is opened; the RPC still stores it.

## Alternatives considered

- **Per-viewer bolt-ons** (a mini-store in the artifact viewer): fastest, but three composers and
  three prompt shapes — the fragmentation the user asked to end.
- **Screenshot pins like Base44:** a page cannot rasterise a sandboxed iframe, and remote mode has
  no native capture. Text plus structure is the anchor; the agent opens the file itself.
- **Keeping localStorage and mirroring to the record:** two sources of truth for one list.
