Short: Optional --assignee on dev3 pr create

`dev3 pr create` takes an optional `--assignee <login>` that is passed straight through to `gh pr create --assignee`, repeatable or comma-separated like gh's own flag. Without it nothing changes: nobody is assigned by default, from config, or inferred.

Suggested by @TedFintastic (h0x91b/dev-3.0#2271)
