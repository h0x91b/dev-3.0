An agent's approval request (complete, cancel, launch) is now pushed to the app on every attempt rather than only the first, and a client that reconnects asks again for whatever is still pending — so a retry re-draws the dialog instead of blocking ten silent minutes when the original push was missed. The CLI also stops claiming that approving a `--task`/`--project` target destroys "this session".

Suggested by @assaft-ui (h0x91b/dev-3.0#1669)
