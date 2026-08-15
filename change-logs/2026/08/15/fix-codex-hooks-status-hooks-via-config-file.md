Short: Codex starts again on Windows

Fixed launching Codex on Windows, where every session died with `expected struct HooksToml` before it began: the status hooks dev3 passes to Codex used to travel as a quoted `-c hooks={...}` argument, and the Windows command line ate their quotes. The hooks are now declared in the Codex config file dev3 already maintains, so nothing about them passes through a command line on any platform.
