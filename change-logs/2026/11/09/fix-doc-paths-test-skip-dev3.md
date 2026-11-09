The documentation-paths test resolves bare file names against git-tracked files instead of walking the folder, so a checkout that keeps its board data or task worktrees in `.dev3/` no longer fails it on `tasks.json` and `projects.json`.

Contributed by @fallenfuzz (h0x91b/dev-3.0#2237)
