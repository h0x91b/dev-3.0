# Importing Codex rollouts: a flat store, and a `user` role that is not the user

## Context

The conversation import shipped for Claude Code only (`decisions/` sibling work, PR #1587). Extending it to
Codex meant two problems Claude does not have. Codex's store is a flat date tree — `<Y>/<M>/<D>/rollout-*.jsonl`
with the working directory only inside the file — where Claude's is keyed by encoded working directory, so the
project's own name cannot pick out candidates. And Codex writes its own context into the `user` role: the
AGENTS.md preamble, `<environment_context>`, `<skill>`, `<turn_aborted>`, attached images. Claude ships an
`ai-title` record; Codex ships nothing, so a title has to come from the first request — and the first `user`
message in almost every rollout is an injection, not a person.

## Investigation

Measured on this machine's real store: 836 rollouts, 1.37 GB, 6 422 `user` messages in the model-facing history
against 4 603 in Codex's own `event_msg`/`user_message` stream — which is exactly what the UI showed as user
input, and therefore usable as ground truth. The 1 819-message gap is the injections.

The obvious predicate — "a `user` message whose text opens with an XML-ish tag is injected" — was validated
against that ground truth and **rejected**: it misclassified 686 `<dev3-ai-message>` blocks, which are
agent-to-agent messages a person's own board really sent. An explicit list of Codex's own tags plus four heading
forms agrees with the ground truth on 99.81% of 6 159 messages (4 false positives, 8 false negatives), and the
four false positives are Desktop-app blobs that arguably should be dropped anyway.

`event_msg` could not simply be used instead: `codex exec` and SDK sessions emit no `user_message` events at all,
so relying on it loses real turns. `response_item` stays canonical, filtered.

## Decision

`isCodexInjectedUserText` in `src/shared/conversation-parsers/codex.ts` owns the predicate, as an explicit
allowlist of injected tags and headings. The parser marks matching events `meta.injected` rather than dropping
them — they are history — and `firstUserRequest` (`src/shared/conversation-render.ts`) skips them, so no import
is titled after an AGENTS.md. `classifyCodexRollout` in `src/bun/conversation-import.ts` counts turns and takes
the title the same way.

The flat store is scanned in two phases (`scanCodexStore`): a bounded 256 KB head read of every rollout for its
`session_meta` line, then a full read only of the few whose `cwd` lies inside the project. The largest header on
this machine is 45 KB, and a head with no complete line is reported as a miss rather than half-parsed. Live
result: 207 importable conversations found for a 215-session project in 616 ms, without reading the 1.37 GB.

## Risks

The injection list is Codex's, not a standard, so a new Codex release can add a block shape it does not know.
The failure is mild and visible — an extra counted turn, or a card titled after an injected block — never a lost
conversation. `src/bun/__tests__/conversation-import.test.ts` pins the known shapes and, deliberately, pins that
`<dev3-ai-message>` is kept.

A project whose rollouts number in the tens of thousands pays one `open`+`read`+`close` each per scan. The scan
is user-triggered and runs once per dialog, so this was accepted rather than cached; a cache would need
invalidating against a store dev3 does not own.

## Alternatives considered

Trusting `event_msg`/`user_message` as the definition of a turn — rejected, it does not exist in `codex exec`
and SDK sessions. Titling Codex rows `Codex session <date>` to dodge the problem entirely — rejected, an
undifferentiated list of dates is not a thing anyone can pick from. Indexing the Codex store into a sidecar to
avoid the header reads — rejected as premature at 616 ms, and it would mean owning a cache of somebody else's
directory.
