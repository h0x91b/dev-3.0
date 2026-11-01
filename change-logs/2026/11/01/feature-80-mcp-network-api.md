Short: --json for task create, update and move

`dev3 task create`, `task update` and `task move` take `--json` and print a versioned `{schemaVersion, task}` projection (a start through the approval dialog prints its outcome), so scripts no longer parse the sentence.
