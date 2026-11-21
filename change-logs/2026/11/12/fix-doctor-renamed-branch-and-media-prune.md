Short: Old shared media expires after 60 days

`dev3 doctor --worktrees` now protects leftover worktrees on renamed unmerged branches with the 60-day floor, which it used to apply only to `dev3/task-*` branches. Artifact downloads build their ZIP on demand instead of storing a second copy of every asset, and doctor plus the daily cleanup delete images and videos of 5 MB or more after 60 days and old stored ZIPs after 30, skipping anything an open task still shows.
