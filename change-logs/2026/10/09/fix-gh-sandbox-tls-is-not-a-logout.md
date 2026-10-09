Short: Sandboxed gh TLS errors no longer mean "log in"

`dev3 pr create` and `dev3 pr auto-merge` now recognise the macOS agent-sandbox TLS failure (`x509: OSStatus -26276`) and exit 28 with an explanation instead of telling the agent to run `gh auth login`; genuinely bad credentials still exit 23, and the agent protocol now says the same about any `gh` call.

Suggested by @banuni (h0x91b/dev-3.0#1925)
