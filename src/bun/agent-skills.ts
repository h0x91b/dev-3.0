import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createLogger } from "./logger";

const log = createLogger("agent-skills");

const SKILL_CONTENT = `---
name: dev3
description: "MANDATORY — invoke BEFORE doing anything else. Trigger: your working directory (PWD) is inside a .dev3.0/worktrees/ path. This means you are a dev-3.0 managed AI agent with a Kanban task assigned. Step 1: invoke this skill. Step 2: handle the user's request. NEVER skip step 1, even if the user gives a direct command."
user-invocable: true
---

# dev3 — Task Lifecycle Protocol

You are working inside a **dev-3.0 managed worktree** with a Kanban board task assigned to you.

## On session start

Run these two commands **in parallel** (two Bash tool calls in one message) to save time:

- \`~/.dev3.0/bin/dev3 --help\` — learn all available CLI commands
- \`~/.dev3.0/bin/dev3 current\` — see your current project, task, and status

Then set \`in-progress\` and begin working.

## Task status management (CRITICAL — NON-NEGOTIABLE)

### Status transitions — every turn:

1. **Start of every turn** — run \`~/.dev3.0/bin/dev3 task move --status in-progress\` when you receive a message and begin working.
2. **End of every turn** — before your final response, you MUST move the task to one of exactly two states:
   - **\`user-questions\`** — you need user input, clarification, or the ball is on the user's side for any reason. **This is the default if the task is not yet complete.**
   - **\`review-by-user\`** — you believe the task is fully complete from your side.
3. **\`in-progress\` is transient** — it MUST NEVER remain after you finish responding. It only exists while you are actively working.

### Rules:

- If \`task move\` fails because the task is already in the target status, that is OK — just continue.

## Notes (per-task scratchpad)

Use \`dev3 note add "..."\` to record important findings, decisions, or context. Notes survive worktree destruction — they are valuable for continuity. Keep them concise and useful; don't flood with noise, but do log key insights that would help if someone revisits the task later.

## Labels

Use labels to categorize tasks. Labels are project-scoped — create them once, apply to many tasks.

- \`dev3 label list\` — list all labels in the project
- \`dev3 label create "bug"\` — create a new label (auto-assigns a color)
- \`dev3 label set <label-id>\` — assign label(s) to the current task
- \`dev3 label set --clear\` — remove all labels from the current task
- \`dev3 label delete <label-id>\` — delete a label (removes from all tasks)
- \`dev3 tasks list --label <label-id>\` — filter tasks by label

## Task title

If the task title is unclear or auto-generated (e.g., a truncated message or a bare link), update it once you understand the task: \`dev3 task update --title "Clear description"\`.

## @file syntax

For long content (descriptions, notes), use \`@path\` to read from a file: \`dev3 note add @findings.md\`.
`;

/** Agent skill directories relative to $HOME. */
const SKILL_DIRS = [
	".claude/skills/dev3",
	".cursor/skills/dev3",
	".agents/skills/dev3",
	".codex/skills/dev3",
	".gemini/skills/dev3",
	".opencode/skills/dev3",
];

/**
 * Install the dev3 skill into all supported AI agent directories.
 * Overwritten on every app start to match the running version (same pattern as CLI binary).
 */
export function installAgentSkills(): void {
	const home = homedir();
	for (const dir of SKILL_DIRS) {
		const skillDir = `${home}/${dir}`;
		const skillFile = `${skillDir}/SKILL.md`;
		try {
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(skillFile, SKILL_CONTENT, "utf-8");
			log.info("Agent skill installed", { path: skillFile });
		} catch (err) {
			log.warn("Failed to install agent skill (non-fatal)", {
				path: skillFile,
				error: String(err),
			});
		}
	}
}
