Short: PR creation never pushes into the base

`dev3 pr create` now always pushes the task branch to a remote branch of the same name, so a branch renamed with `git branch -m` that still tracks the base no longer tries to push into `main` when `push.default` is `upstream`.

Suggested by @tourofer (h0x91b/dev-3.0#2289)
