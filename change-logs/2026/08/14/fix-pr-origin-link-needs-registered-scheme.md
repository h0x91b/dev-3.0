Short: PR back-link only where it works

On Windows and Linux the "Link pull requests back to the task" setting is now off and disabled, with a line explaining why: neither registers a handler for dev3:// links, so the deep link dev3 appended to a public pull request went nowhere when clicked. Pull requests opened from those hosts no longer carry the footer; your saved preference is left untouched on disk and still applies on a machine that has a handler.
