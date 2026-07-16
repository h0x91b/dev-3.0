# Context

The native terminal consumes PTY bytes and state while OSC 52 clipboard content arrives separately as an RPC push. Both transports expose `AsyncStream`, whose elements are divided rather than broadcast when multiple iterators consume the same stream.

# Investigation

Giving TerminalKit its own iterator over `RPCClient.pushes` could steal board or lifecycle events from the app's state owner. Opening a second RPC socket would also duplicate reconnect, refresh, and refetch behavior.

# Decision

`Dev3TerminalEndpoint` adapts `PTYClient` directly for output, input, resize, and transport-neutral state. The future app store remains the only RPC push consumer and routes individual events into `Dev3TerminalEventChannel`, which filters OSC 52 payloads by task ID and exposes a bounded clipboard stream.

# Risks

The app store must route every received push to the active task channel before applying its normal state update. A missed route loses that clipboard event because server pushes have no replay.

# Alternatives considered

We rejected consuming `RPCClient.pushes` in TerminalKit and rejected a second RPC client dedicated to clipboard traffic. We also rejected parsing OSC 52 from PTY output because the server removes those sequences before forwarding PTY frames.
