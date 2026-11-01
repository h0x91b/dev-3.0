# One command receives the secret; its output is discarded

## Context
An agent may need a token for a command while the user wants its value kept out of agent conversations, terminal input and dev3's persisted state. Exporting into an existing terminal would expose it through shell history, terminal capture or agent tools.

## Investigation
The authenticated renderer RPC can carry a value directly to the host without terminal input. CLI requests have an abort signal when their connection closes; reconnecting renderers can list pending metadata without retrieving a value.

## Decision
`SecretRequests` holds only request metadata. `dev3 secret run --env NAME -- command args...` opens a queued agent-request modal; the host revalidates the task run and spawns the displayed argv with the value in the child environment, closed stdin and ignored stdout/stderr. Requests never auto-approve, expire after ten minutes, and commands have a five-minute limit; only status returns to the agent.

## Risks
The approved command and its descendants are trusted: they can save or transmit the value, and background descendants may outlive the command. JavaScript cannot guarantee zeroing memory, and the OS, browser extensions, crash dumps and same-user processes are outside this boundary. Remote entry requires HTTPS or loopback in the UI; existing authentication and telemetry consent remain unchanged, with input explicitly excluded from capture.

## Alternatives considered
Returning the secret to the agent or injecting a terminal export defeats the privacy goal. Output redaction misses encoded, split or transformed values, so this first version discards all output. Persistent credential storage and restarting an entire agent with new environment variables would widen lifetime and exposure unnecessarily.
