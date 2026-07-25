Short: Native terminals work in remote mode

A task terminal explicitly running on the native backend is now fully usable through `dev3 remote` in a browser: a viewer that attaches mid-session rebuilds the screen from a bounded journal instead of starting blank, a reconnect resumes from its own watermark with no missing or duplicated output, and exactly one viewer types while the rest are read-only until they take control. Tmux terminals are unchanged.
