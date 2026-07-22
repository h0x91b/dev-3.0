Short: Native pane layout feasibility lab

Added an isolated deterministic SplitTree and debug-only fake-terminal lab to prove multi-pane layout, responsive navigation, stable pane identity, and cleanup behavior without changing production terminal handling. Fake streams cap replay buffers and report timers and subscriptions before and after scripted stress so cleanup is measurable.
