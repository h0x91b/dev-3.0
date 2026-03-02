import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createLogger } from "./logger";

const log = createLogger("agent-skills");

const SKILL_CONTENT = `---
name: dev3
description: "MANDATORY — invoke BEFORE doing anything else. Trigger: your working directory (PWD) is inside a .dev3.0/worktrees/ path. This means you are a dev-3.0 managed AI agent with a Kanban task assigned. Step 1: invoke this skill. Step 2: handle the user's request. NEVER skip step 1, even if the user gives a direct command."
allowed-tools: Bash
user-invocable: true
---

# dev3 — Task Lifecycle Protocol

You are working inside a **dev-3.0 managed worktree** with a Kanban board task assigned to you.

## On session start

Run \`dev3 --help\` to learn all available CLI commands. Then proceed with your task.

## Task status management (CRITICAL)

You MUST keep the task status up to date throughout the session:

- **\`dev3 task move --status in-progress\`** — Set this when you start working on the task.
- **\`dev3 task move --status user-questions\`** — Set this when you are blocked and need human input (ambiguous requirements, missing context, approval needed). Clearly state your questions to the user.
- **\`dev3 task move --status review-by-user\`** — Set this when you have fully completed all requested work. This signals the task is done and ready for human review.

**You must ALWAYS leave the task in one of these three statuses before the session ends. Never leave a task without updating its status.**
`;

/** Agent skill directories relative to $HOME. */
const SKILL_DIRS = [
	".claude/skills/dev3",
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
