Short: Failed macOS updates now say why

A macOS update that cannot replace the running app — dev3 opened from a read-only App Translocation copy or a DMG, or a bundle the user cannot write — now shows the reason and how to fix it instead of spinning on "Restarting…" forever, and is refused before anything is deleted, because the old path could remove half of the running app. Electrobun's updater steps are now written to the dev3 log.
