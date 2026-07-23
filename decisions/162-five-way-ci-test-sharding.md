# 162 — Split CI tests into five composite shards

## Context

The full test job launched mainview, bun, and CLI Vitest coordinators concurrently on one runner, and each coordinator independently claimed nearly the runner's full worker budget. This produced load-sensitive five-second timeouts and made the single test job the pull-request critical path.

## Investigation

The affected tests passed alone and with capped workers, while concurrent uncapped runs reproduced the failures. A job per suite would remove runner contention but remain poorly balanced because the CLI suite is much shorter; Vitest's deterministic path-hash sharding distributes equal file-count ranges but does not account for historical duration.

## Decision

The Build workflow runs five matrix jobs, and job N executes shard N/5 of mainview, bun, and CLI sequentially. Each suite records its outcome without stopping the shard, every shard uploads one result artifact, and the final `test` gate reads all five artifacts before preserving the existing required-check verdict; this avoids GitHub finalizing the matrix dependency after its first failed child. Matrix fail-fast is disabled, matrix failures are deferred to the artifact gate, and only shard 1 may populate a missing dependency cache.

## Risks

Five runners repeat checkout, Bun setup, cache restore, generated-file work, and artifact upload, increasing total billed minutes even as wall-clock time falls. Hash-based shards can still be imbalanced when unusually heavy files land together, so initial CI timings must be reviewed.

## Alternatives considered

Three jobs split by suite were simpler but would leave the CLI runner idle while mainview continued. A local worker cap remains useful outside CI but cannot shorten CI wall-clock time, while a shared Vitest workspace would require a larger test-configuration migration.
