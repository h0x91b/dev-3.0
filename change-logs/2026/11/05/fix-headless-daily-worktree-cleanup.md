Short: Daily cleanup now runs on dev3 remote

The daily cleanup of old task files now runs on a headless `dev3 remote` install too: the server starts the cleanup scheduler, and the CLI tarball ships the worker bundles it needs (packaging fails if they are missing). A desktop app on the same machine still shares one claim per day, so the cleanup never runs twice.

Suggested by @fallenfuzz (h0x91b/dev-3.0#2183)
