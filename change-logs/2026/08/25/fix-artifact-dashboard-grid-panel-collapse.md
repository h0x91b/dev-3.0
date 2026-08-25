Short: Artifact panels no longer collapse

A panel dropped into an artifact's `.dashboard-grid` without a width class used to land in a single column of the 12-column grid and render as an ~86px sliver with one word per line. Unsized panels now take the whole row, and authors can place them side by side with the new `span-3` … `span-9` classes, which apply above 900px and go full width below that and in print.
