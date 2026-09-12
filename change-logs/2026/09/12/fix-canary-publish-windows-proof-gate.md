Short: Canary publishing works again

Canary publishing stopped producing builds because two Windows-only test failures broke the packaged Windows proof that gates every canary build job. The golden agent-command matrix did not account for Claude's protocol-body path being quoted on Windows, and the new dev-server tmux capture test ran on Windows where the tmux backend does not exist.
