Short: Per-task token usage and cost in the CLI

`dev3 stats usage --task <id|seq:N> [--json]` reports one task's tokens by type (cache writes split 5m/1h), messages and API-equivalent cost per model, from the Claude transcripts of its working directory (subagents included) and the Codex rollouts that ran there, so outside agents get a task's cost from dev3 itself, over ssh too. It works for finished tasks whose worktree is gone, and says how many archived sessions no longer have a transcript to count.
