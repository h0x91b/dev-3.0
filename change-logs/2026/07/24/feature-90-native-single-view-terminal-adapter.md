Short: Native single-view terminal adapter

Composed the merged native terminal primitives (session registry, attach client, versioned record, ownership, bounded parser-state snapshot) into one dev-internal single-view adapter and drove it through the existing backend-neutral parity corpus — every applicable single-view scenario passes against native while the tmux runner stays green. This is an unused tracer with no product callers; tmux remains the only production terminal backend and no behavior changes for users.

Also made the sharded CI test report self-contained: when a shard's suite fails, the aggregate `test` job now names the exact shard, suite, and failing test titles inline (banner, GitHub annotations, and run summary) so failures are readable without opening any individual shard job.

Along the way the shared parity corpus stopped importing the PTY server for a single pure helper — that import started a WebSocket server at module load and kept the parity E2E process alive long after its checks had passed. The helper now lives in the pure resize-protocol module, and the E2E terminates on its own.

The sharded test gate is honest again as well: piping a suite's output into `tee` ran without `pipefail`, so a failing suite was recorded as passing and the aggregate check went green over a real failure. Those steps now use an explicit bash shell, and a test fails if a piping step ever drops it.
