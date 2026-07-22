Short: Update popover now lists what's new

The update-ready popover's "what's new" list is now populated on real updates, and GitHub Release pages now include a full grouped changelog (Features, Fixes, Refactors). The release pipeline checked out the repo shallow and without tags, so the changelog window could not be computed and shipped empty (v1.38.0 users saw a bare popover); release jobs now fetch full history and tags.
