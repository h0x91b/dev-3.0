Short: Merge offers no longer stall on dev3's own Claude settings

dev3 writes Claude's hooks into each task's `.claude/settings.local.json`; in a repo that does not ignore that file it counted as uncommitted work, which silently held back the "Branch merged, complete the task?" offer and added a false warning to Complete. dev3 now keeps the file out of `git status` through the repo's own `info/exclude`, unless the repo tracks it.

Contributed by @fallenfuzz (h0x91b/dev-3.0#2262)
