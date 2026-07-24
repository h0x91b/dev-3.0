Short: Native single-view terminal adapter

Composed the merged native terminal primitives (session registry, attach client, versioned record, ownership, bounded parser-state snapshot) into one dev-internal single-view adapter and drove it through the existing backend-neutral parity corpus — every applicable single-view scenario passes against native while the tmux runner stays green. This is an unused tracer with no product callers; tmux remains the only production terminal backend and no behavior changes for users.
