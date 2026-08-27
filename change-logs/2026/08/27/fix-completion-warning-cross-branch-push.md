Short: No false lost-commit warning

The completion dialog no longer claims commits will be lost when the branch was pushed to a differently named remote branch: it now asks whether the work is on any remote at all, instead of only looking for `origin/<branch-name>`. A branch that genuinely has nothing on a remote still warns exactly as loudly as before.

Suggested by @vit-pavlenko (h0x91b/dev-3.0#1545)
