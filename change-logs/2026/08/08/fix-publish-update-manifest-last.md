Short: No more updates that fail to download

A release published the update manifest before the file it points at, so an app that happened to check for updates during those few seconds was offered a download that did not exist yet. The manifest is now the last thing written to the release bucket.
