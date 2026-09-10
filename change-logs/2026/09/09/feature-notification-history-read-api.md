Short: Read the recorded notification archive

Added a read API over the notification archive `dev3 notify` already writes: a paged, newest-first reader with per-project scoping applied before anything reaches the wire, its RPC method, and a renderer store that caches a page and refreshes when this instance appends a row. Data only — nothing displays it yet.
