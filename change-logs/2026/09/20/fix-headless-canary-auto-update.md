Short: Headless updates no longer stall

Headless remote servers now update safely around running agents: detached helper restarts preserve them, while supervisor-managed restarts wait. Stalled tarball downloads time out cleanly without abandoning local file operations, so a later attempt can retry.
