Short: Claude sessions start when dev3 runs as root

Claude Code refuses to start under root whenever bypass mode is reachable, which killed every session on a box running dev3 as root (a container or Kubernetes pod). dev3 now declares `IS_SANDBOX=1` for Claude launches when it is running as root, so bypass and Accept Edits presets work there instead of exiting immediately.
