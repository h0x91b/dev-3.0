# Artifact → agent messages, and why the API is `window.dev3`

> Extended on 2026-08-31 by
> `decisions/2026/08/31/keep-unsent-artifact-input-across-versions.md`: every ruling below
> still holds, but "the agent answers by republishing" destroys input the user had typed and
> not yet sent. The draft is now kept outside the frame and `canSendToAgent` became a live
> getter rather than a compose-time constant.

## Context

An HTML artifact published with `dev3 show-artifact` was a one-way surface. When a report asked the
user something — pick one of three options, approve a variant, name the files to skip — the user read
the question in the artifact, switched to the agent pane, and retyped the answer by hand. The richer
the report, the more transcription, and the more the answer drifted from what the report asked.

## Investigation

The obvious home for the API was the starter template's existing `window.dev3Artifact`, alongside
`.asset()`, `.chart()` and `.toast()`. It does not work: that object is built and `Object.freeze`d by
the template's `app.js` (`window.dev3Artifact = Object.freeze({...})`), which runs **after** the
viewer's injected scripts. Anything the injection puts on that name is overwritten and lost.

The template is also the wrong layer for a second reason: an artifact published before this feature
existed, or hand-written without the starter, has no `app.js` at all — and those must be able to ask
a question too.

## Decision

The bridge is injected by the viewer at compose time (`artifactBridgeScript` in
`src/mainview/utils/artifactBridge.ts`, injected by `composeArtifactDocument`), and owns its own
global, `window.dev3`, with two members: `canSendToAgent` and `sendToAgent(text)`. The template's
runtime shell is untouched and its version is not bumped; the authoring guide states that report and
shell code must never define or shadow `window.dev3`.

The bridge is authored as a real function and serialized with `Function.prototype.toString`, unlike
the viewer's other injected scripts, which are hand-written strings. It carries real logic — the
parent-frame check, the gesture window, the single-in-flight rule, the timeout — and that logic is
directly unit-tested (`src/mainview/utils/__tests__/artifactBridge.test.ts`, including one case that
executes the serialized text).

The channel is one-way. The agent answers by republishing the artifact, which adds a version through
the mechanism that already exists; there is no push into an open document.

`canSendToAgent` conflates several "you cannot send from here" conditions into one boolean —
not the newest version, terminal task, not inside the viewer's frame — because the artifact's only
sensible reaction to all of them is the same: do not render the form. The distinction survives in the
rejection `reason` for authors who want to explain a failure after a click.

Delivery goes through `sendArtifactMessageToAgent`
(`src/bun/rpc-handlers/artifact-messages.ts`) → `sendMessageImmediately(..., { hold: false })`, the
same non-holding path the diff viewer's "Send to agent" uses: the user just clicked and is watching
the pane. The text is wrapped by `wrapArtifactMessage` in the same module and tag family as the
cross-agent `<dev3-ai-message>` envelope.

## Risks

- **The trust model is a guard, not a boundary.** `sendToAgent` requires a recent *trusted* input
  event, so a stray timer or a script the report pulled in cannot drive the agent unattended. Anyone
  able to author the artifact could have used the agent's own tools directly, so this is deliberately
  not hardened further — and it must not be "simplified away". `navigator.userActivation` was not
  used: it is not available across all three engines the app runs on.
- **Serializing a function couples the bridge to bundler behaviour.** It must reference nothing
  outside its own body except its two arguments. The test that executes the serialized text is what
  catches a violation.
- **The template shell shadowing `window.dev3` would kill the bridge silently.** Stated in
  `AUTHORING.md` and here; not enforced by a test, because the template shell is not loaded by the
  renderer test suite.

## Alternatives considered

- **Extend `window.dev3Artifact`** — impossible without editing the frozen shell, and it would leave
  every non-starter artifact without the API.
- **A declarative `<form>` binding** — less code for the author, but it hides the failure modes
  (`busy`, `timeout`, no agent) that a report has to render something for.
- **Queue an undeliverable submission, or write it into a task note** — makes "sent" ambiguous. A
  failed send fails, loudly.
