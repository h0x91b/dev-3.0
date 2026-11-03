Short: PR watch follows any pull request

`dev3 pr watch --pr <N>` now follows any open pull request of the project's repository, fork heads and review targets included, so a coordinator can hear when a PR it handed to another task finishes CI or merges; several PRs can be watched at once, `--off --pr <N>` drops one, and an already merged or closed PR exits with code 43.
