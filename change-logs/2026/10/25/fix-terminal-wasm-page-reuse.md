Short: Prevent terminal resize stalls

Clear reused terminal memory to prevent resize stalls, crashes and stale text caused by dirty WASM pages. Preserve the existing terminal cleanup fix and verify the packaged core with isolated resize, scrollback and text regression tests.
