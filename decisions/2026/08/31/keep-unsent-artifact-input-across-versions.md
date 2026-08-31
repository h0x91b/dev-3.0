# Unsent artifact input outlives the version it was typed into

Extends `decisions/2026/08/28/artifact-to-agent-message-channel.md`. That record's rulings all
stand — the channel is still one-way, the agent still answers by republishing, and the bridge
still owns `window.dev3`. This is the cost of those rulings, paid.

## Context

First real user feedback on the channel, from Evgeny Alterman (Slack, 31 Aug 2026): he filled a
long form inside a published report, the agent republished the artifact while he was still
typing, and the text was gone before he pressed send. Reproduced exactly: a new version replaces
`artifactViewer.artifacts` (`src/mainview/App.tsx`, `onCliShowArtifact`), the viewer's selected
version jumps to the new latest, the compose effect blanks `srcDoc`, and the iframe — with every
typed character in it — is unmounted. No warning, no undo, and the Send button stays enabled, so
nothing on screen even looks broken.

Two correct behaviours collide: answering by republishing is what the 28 Aug record decided, and
it is what destroys the answer.

## Investigation

The obvious fix is storage inside the artifact — `sessionStorage`, restored on load. It is
impossible, measured in a real browser rather than assumed: the viewer renders the document with
`sandbox="allow-scripts"` and deliberately no `allow-same-origin`
(`TaskArtifactViewer.tsx`), so its origin is opaque — `location.origin` is the string `"null"` —
and `sessionStorage`, `localStorage` and `document.cookie` each throw
`SecurityError: The document is sandboxed and lacks the 'allow-same-origin' flag`. Granting the
flag is not on the table: a same-origin frame can reach `parent.document` and drive the whole
app, and artifacts are written by an agent.

Restoring the values into the *new* document was rejected on its own merits. A republished report
usually asks a different question, so an answer to the old one would land silently under a new
label — worse than losing it.

## Decision

The draft lives **outside** the frame, in the viewer, and is never poured into a document it did
not come from.

- The bridge (`src/mainview/utils/artifactBridge.ts`) reports every control whose value no longer
  matches its default out through `postMessage` as `dev3-artifact-draft`, debounced by
  `ARTIFACT_BRIDGE_DRAFT_MS`. Automatic: the author writes nothing. `password`, `file` and
  `hidden` fields are excluded, and `dev3.saveDraft(value)` carries state the DOM does not hold,
  handed back as a `dev3:draft-restore` event.
- `TaskArtifactViewer` holds one draft keyed by artifact id and version. When a republish moves
  the user off that version, a conditional non-blocking notice offers *Back to version N*;
  returning re-applies the values on `onLoad` and fires `input`/`change` on each control.
  Dismissing hides the notice and keeps the draft.
- `canSendToAgent` is true on the version being answered, not only on the newest one. Without
  that, deferring the loss would only trade a wiped form for a dead button.
- `canSendToAgent` became a live getter fed by a `dev3-artifact-can-send` message, and left the
  compose effect's dependencies. Re-composing the document to flip a boolean unmounts the iframe
  — the exact wipe this record exists to remove.

## Risks

- **The draft dies with the viewer.** Closing it discards the text. Persisting further would mean
  storing a user's half-written answer on disk, which is a bigger promise than the problem needs.
- **Positional field keys.** A control with no `id` and no `name` is keyed by tag and position,
  and a key two controls share — every member of a radio or checkbox group carries one `name` —
  is disambiguated by its occurrence number. Safe only because a draft is restored solely into
  the version it was captured from — that invariant is load-bearing, not incidental. A name-only
  key was not merely lossy: every member of the group matched it, the last one written won, and
  the user's second option came back as the fifth.
- **Restore fires synthetic `input`/`change`.** A report that treats those as user intent (auto
  submit) would act on a restore. No such report exists; the alternative is authors seeing stale
  mirrored state, which is worse.

## Alternatives considered

- **`sessionStorage` in the artifact** — throws; see above.
- **`allow-same-origin` so storage works** — hands agent-authored HTML the app's origin.
- **Restore into the new version's form** — puts an answer under a question it does not answer.
- **Confirm before swapping** — the swap is not user-initiated, so a modal interrupts them with a
  decision they never asked for.
- **Refuse to swap until the form is clean** — keeps the context but needs the same
  send-on-an-older-version work anyway, for more code and a viewer that ignores its own data.
