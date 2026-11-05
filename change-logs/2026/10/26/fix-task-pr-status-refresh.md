Short: PR badges stay current

PR badges keep their state and CI current after branch changes and while a task stays open, including narrow layouts. Regular reads use GraphQL with a shared one-minute cache and coalesced requests; boards check about every minute in the active project and every five minutes in the background, while watched PRs keep a minute cadence and require fresh samples to confirm CI. Manual refresh requests fresh PR data alongside git fetch; transient failures retry on the next poll, confirmed merges survive API outages, and inaccessible or missing saved PRs cannot hide the current branch's open PR or pause unrelated repositories.

Contributed by @diverru (h0x91b/dev-3.0#2037)
