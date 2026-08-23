Short: Cross-project replies now work

A cross-task agent message sent between two different projects handed the receiver a reply command it could not run: `dev3 message` scopes every request to the sender's own board, so the bare `--task seq:<N>` was looked up there and failed. The generated `<reply-with>` command — and the reply command printed after an agent-initiated launch — now carry `--project <id>` whenever the two tasks live on different boards, and a scoped "task not found" error names the project it searched instead of blaming an id change.
