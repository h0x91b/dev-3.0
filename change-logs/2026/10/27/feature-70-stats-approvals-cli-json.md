Short: Stats and approvals in the CLI

New read-only `dev3 stats productivity|usage|limits|memory` and `dev3 approvals list` commands expose what the Stats page, rate-limit indicator, memory widget and approval dialogs show, with a versioned `--json` form (`schemaVersion: 1`) for scripts and agents outside the app. `dev3 task show --json` also gains `prStatus`, `hibernated` and `keepAlive`, and productivity records now carry the task `seq`.
