Short: Codex errors and approval holds reach Has Questions

A Codex task whose turn dies on an API error (a 403, a usage limit, an auth failure) no longer sits in "Agent is Working" forever: dev3 now spots the error in Codex's rollout and moves the task to Has Questions with a badge and desktop notification. A Codex turn that ends asking you to type an `Approved <ref>` reply for a security hook lands in Has Questions too, instead of review.
