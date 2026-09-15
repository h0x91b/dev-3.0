Short: Completion warns only about real loss

The completion dialog no longer claims commits "will be lost" when another branch, tag or remote-tracking ref still reaches them, which is what happens after a task branch is merged into the local base but not pushed. Those commits now read as unpushed but kept, and "will be lost" is reserved for work that deleting the branch really does destroy.

Suggested by @vit-pavlenko (h0x91b/dev-3.0#1684)
