Short: Outside agents can message tasks

Agents running outside dev3 can now message a task as a registered external sender (`dev3 message --as-sender <id>`), and the task's agent can answer into that sender's inbox (`dev3 message --to-sender <id>`, read with `dev3 sender inbox --wait 25 --json`). `dev3 message --json` prints the message id and delivery status, and a connection lost after sending exits 11 instead of a generic error.

Suggested by @mcaldas (h0x91b/dev-3.0#2066)
