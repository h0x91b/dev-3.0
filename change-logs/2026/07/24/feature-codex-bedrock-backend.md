Short: Codex can run on Amazon Bedrock

The Codex agent now supports Amazon Bedrock as an LLM backend, selectable per agent in Settings → Agents (same toggle Claude already has). dev3 rewrites its model aliases to Bedrock's `openai.<model>` ids and routes the launch via `-c model_provider="amazon-bedrock"`; credentials and region stay in your own ~/.codex/config.toml. Model ids for all providers are now derived from the config alias, so new models need no mapping-table edits.
