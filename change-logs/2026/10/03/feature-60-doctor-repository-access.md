Short: Doctor explains "not a git repository"

`dev3 doctor` run inside a git checkout now probes the repository and tells a deleted repo, a file-permission problem and an access denial apart — Git reports all three as `not a git repository` — listing possible causes for a denial and naming the binary that hosts the terminal. The troubleshooting guide gains a section for task terminals that lose access to Desktop or Documents on macOS: finding the tmux binary that is actually running, adding it to Full Disk Access, and what that grant allows.
