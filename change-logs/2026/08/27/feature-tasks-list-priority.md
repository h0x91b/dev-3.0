Short: Priority in dev3 tasks list

`dev3 tasks list` now prints a PRI column and orders each group the way the board orders a column — highest priority first, newest seq breaking ties; `--sort seq` restores the old chronological order. `--priority P0,P1` filters by band and composes with `--status` and `--label`, the coordinator's `<dev3-board>` snapshot carries each task's priority, and the singular `dev3 project list` now works as an alias instead of failing with "Unknown command".
