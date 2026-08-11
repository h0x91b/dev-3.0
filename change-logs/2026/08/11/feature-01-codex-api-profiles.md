Short: Codex API profiles

Settings → Agent Accounts now offers "Add API profile" for Codex, not just Claude Code: paste a base URL, an API key and a model id once, pick that account when launching a task, and Codex runs against your own OpenAI-compatible endpoint (Baseten, OpenRouter, a local vLLM server). dev3 hands the provider to codex on the command line and never touches your ~/.codex/config.toml, so your existing profiles, MCP servers and permission modes keep working.
