Short: Review a PR from the CLI

`dev3 task create --pr <number>` now starts the task on the pull request's own branch — a fork too — so a CLI-created review task lands exactly where a GUI-created one does, marked as somebody else's code. `--branch <ref>` does the same for a branch that is not a pull request. A ref that does not resolve creates nothing and exits 18 instead of quietly leaving the task on the base branch, and `dev3 task create --help` plus the agent skill now spell out how a review task is meant to be created.
