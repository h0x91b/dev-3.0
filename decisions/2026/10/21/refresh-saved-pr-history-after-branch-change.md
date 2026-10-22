# Refresh saved PR history after a branch change

## Context

A task can keep its PR number while work continues on a renamed or follow-up branch. The inspector and board still show that saved PR, but `pollTaskPrStatus` discarded its GitHub response when the head branch differed, leaving its cached OPEN state indefinitely.

## Investigation

A read-only comparison of active boards with GitHub found an actual merged PR whose task had switched to a follow-up branch. Logs repeatedly reported a head mismatch; regression tests reproduce both MERGED and CLOSED being returned as not-found.

## Decision

`src/bun/lifecycle/activities.ts` now persists and pushes the current state of a saved PR even if its head differs. It requires a matching branch before promotion, attention notifications, or emitting merge-completion findings. The shared inspector hook refreshes rich PR data while visible and on explicit refresh; board polling uses one/five-minute active/background intervals. `src/bun/github-pr-status.ts` shares rich GraphQL reads for one minute by host, account, repository, branch, and saved PR, including in-flight requests and number snapshots; merged PR checks also expire because CI can finish after merge. Branch polling publishes newly read rich data immediately, without rewriting unchanged data; explicit refresh bypasses completed results.

Failed reads are removed from the caches so the next poll can retry. Snapshot-only readers keep immutable MERGED state and head proof independently of the rich status TTL, using the last resolved repository identity even during a failed discovery refresh. Only NOT_FOUND errors exactly at the saved PR alias may retain partial branch results; unrelated GraphQL errors still fail. Publishing rich status cannot discard an already discovered PR, and account-wide backoff requires rate-limit headers or an explicit rate-limit message rather than any HTTP 403.

## Risks

The direct GraphQL query must track GitHub schema changes; announced breaking changes have at least three months of notice. A single 15-second deadline covers auth, repository discovery, queries, and pagination. API rate-limit headers are honored; metadata-only reads preserve PR identity when CI is inaccessible, while incomplete CI becomes unknown rather than green. A historical PR never authorizes completion of follow-up work.

Credentials and SSH-alias repository discovery still use `gh`, cached by the existing auth policy and a five-minute repository TTL. CI contexts are paginated against a fixed commit; unresolved-thread pages use the same PR number, and a later thread-page failure preserves PR/CI with an unknown thread count. The PR scheduler checks due tasks every 15 seconds and schedules from the shared sample timestamp, avoiding extra minutes caused by positive jitter or a cache hit just before expiry. HTTPS connections belong to Bun fetch and are independent of git SSH ControlMaster.

Merge proof still requires a resolvable current GitHub account; an authentication failure cannot authorize reuse of another account's proof. A successful discovery of a different repository replaces the cached identity. Successful no-PR results retain the agreed one-minute TTL.

## Alternatives considered

Dropping the saved badge would hide task history and conflict with the existing PR ledger. Removing the head check from lifecycle actions would let another branch's PR promote or complete the current task.

Keeping per-poll `gh pr list/view` processes would preserve duplicated reads and separate connection lifetimes. REST would provide version pinning but require more endpoints for the combined status. Removing `gh` authentication or user commands would expand scope without helping the polling bottleneck.
