Short: One diff entry per counter

Removed the redundant standalone Diff button from the task git bar. The top file counter now always opens the committed branch diff, the lower +/− counter opens uncommitted changes (or the branch diff when the tree is clean), and their tooltips explain which changes each one counts. Reported by Akvile Ruginyte.
