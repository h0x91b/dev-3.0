Short: Bedrock agents pin haiku and sonnet too

Claude · Bedrock launches now also set `ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL` from the same alias map as the main model, so `/model haiku`, `/model sonnet` and subagents with a `model:` alias stop falling back to Claude Code's built-in `us.anthropic.*` ids, which an account restricted to `global.` profiles rejects with a 403.
