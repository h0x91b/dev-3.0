Short: Clone paths never overwrite committed files

Clone paths no longer replace files git tracks: a path holding committed files in the task worktree or the project root is skipped with a notice on the task instead of being swapped for the root's older working copy, auto-detection leaves tracked folders such as a source `build/` out, and an explicit `"clonePaths": []` in `.dev3/config.json` or `.dev3/config.local.json` now turns cloning off and shows as the winning source in `dev3 config show`.

Suggested by @yhattav (h0x91b/dev-3.0#2026)
