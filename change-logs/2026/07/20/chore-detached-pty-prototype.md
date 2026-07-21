Short: Detached-PTY ownership spike

Added an isolated spike (src/bun/prototypes/detached-pty/) proving a detached Bun process can own one Bun.Terminal shell while short-lived clients disconnect and reattach to the same live shell over loopback TCP, with an explicit stop that terminates the owned process tree and removes its metadata. Fully additive groundwork for the tmux-removal roadmap: nothing in the app or CLI imports it, it never touches tmux, pty-server, or existing terminal flows, and a real-Bun integration test (bun run test:proto-e2e) proves the tracer never invokes tmux.
