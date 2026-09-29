Short: Setup no longer prints startup secrets

The setup script (initial setup and re-runs) no longer runs under shell tracing (`-x` / `Set-PSDebug`), which also traced the shell's startup files and printed any credential they exported, expanded, into the setup pane before the script could turn tracing off. Setup still runs and still reports "Setup done" or "Setup failed (exit N)" exactly as before.
