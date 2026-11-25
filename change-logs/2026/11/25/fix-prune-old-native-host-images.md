Short: Old native host images are pruned

Staged native host images under the dev3 data directory were never removed and piled up with every update. dev3 now deletes images that are not among the two most recently used, were last used over 7 days ago, and have no live session, plus abandoned staging scratch directories older than a day.
