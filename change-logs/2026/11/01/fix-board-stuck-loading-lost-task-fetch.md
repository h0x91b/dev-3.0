Short: Board no longer stuck loading

A board whose initial task fetch was lost (for example across a remote WebSocket reconnect) no longer sits on "loading" showing only the few cards that arrived by push; it keeps the skeleton until the snapshot lands and offers the Retry panel after 20 seconds.
