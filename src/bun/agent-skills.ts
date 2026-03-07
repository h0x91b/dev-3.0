import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createLogger } from "./logger";
import { ensureCodexConfigFile } from "./codex-config";

const log = createLogger("agent-skills");

// ---- Shared skill body (everything after frontmatter) ----

const SKILL_BODY = `# dev3 — Task Lifecycle Protocol

You are working inside a **dev-3.0 managed worktree** with a Kanban board task assigned to you.

## Branch naming

After learning your current task, check if the branch matches \`dev3/task-*\` (opaque auto-generated name).
If it does, **rename it immediately** to something meaningful based on the task description:

\`\`\`bash
git branch -m dev3/task-XXXXXXXX dev3/<slug>
\`\`\`

**Rules:**
- Always keep the \`dev3/\` prefix.
- Use lowercase kebab-case, 3-5 words: \`dev3/fix-auth-race-condition\`, \`dev3/add-drag-reorder\`.
- Derive the slug from the task description/title — be concise but descriptive.
- If the branch already has a meaningful name (does NOT match \`dev3/task-*\`), skip renaming.
- If the branch was already pushed, also update the remote: \`git push origin :<old> && git push -u origin <new>\`.

Run this ONCE at session start, right after setting \`in-progress\`.

## Title generation

The task title is auto-generated from the first 80 characters of the description.
After learning your current task, if the title looks truncated (ends with "…") or is
longer than ~6 words, synthesize a concise title and update it:

  dev3 task update --title "Short imperative phrase"

Good titles: "Fix auth race condition", "Map missing keyboard bindings", "Add drag-to-reorder support"
Bad titles: copies of the description, vague summaries, titles with ellipsis
Run this ONCE at session start, before doing any other work.

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

const SKILL_DESCRIPTION = "MANDATORY — invoke BEFORE doing anything else. Trigger: your working directory (PWD) is inside ~/.dev3.0/worktrees/ (i.e. $HOME/.dev3.0/worktrees/). Regular git worktrees or other worktree paths do NOT qualify — only the dev-3.0 managed path. Step 1: invoke this skill. Step 2: handle the user's request. NEVER skip step 1, even if the user gives a direct command.";

// ---- Claude Code skill (uses !`command` injection for zero tool calls at startup) ----

const CLAUDE_SKILL_CONTENT = `---
name: dev3
description: "${SKILL_DESCRIPTION}"
user-invocable: true
---

${SKILL_BODY}
## Skill loaded at

!\`date '+%Y-%m-%d %H:%M:%S %Z'\`

## Status (auto-set on skill load)

!\`~/.dev3.0/bin/dev3 task move --status in-progress 2>&1\`

## CLI reference

\\\`\\\`\\\`
!\`~/.dev3.0/bin/dev3 --help\`
\\\`\\\`\\\`

## Your current task

\\\`\\\`\\\`
!\`~/.dev3.0/bin/dev3 current\`
\\\`\\\`\\\`
`;

// ---- Generic skill for other agents (Cursor, Codex, Gemini, etc.) ----

const GENERIC_SKILL_CONTENT = `---
name: dev3
description: "${SKILL_DESCRIPTION}"
user-invocable: true
---

${SKILL_BODY}
## On session start

Run these two commands to learn about available CLI commands and your current task:

- \`~/.dev3.0/bin/dev3 --help\` — learn all available CLI commands
- \`~/.dev3.0/bin/dev3 current\` — see your current project, task, and status

Then set \`in-progress\` and begin working.
`;

/** Claude Code skill directory (supports !`command` injection). */
const CLAUDE_SKILL_DIR = ".claude/skills/dev3";

/** Generic agent skill directories (no command injection support). */
const GENERIC_SKILL_DIRS = [
	".cursor/skills/dev3",
	".agents/skills/dev3",
	".codex/skills/dev3",
	".gemini/skills/dev3",
	".opencode/skills/dev3",
];

// ---- ~/.agents/AGENTS.md rule block ----

const AGENTS_MD_MARKER_START = "<!-- dev3:start -->";
const AGENTS_MD_MARKER_END = "<!-- dev3:end -->";

const AGENTS_MD_BLOCK = `${AGENTS_MD_MARKER_START}
## dev-3.0 Managed Worktree

If your working directory (PWD) is inside \`~/.dev3.0/worktrees/\` (i.e. \`$HOME/.dev3.0/worktrees/\`), you are a **dev-3.0 managed AI agent** with a Kanban task assigned. Regular git worktrees or other paths containing "worktrees" do **NOT** qualify — only the dev-3.0 managed directory under the user's home.

**MANDATORY — do this BEFORE any other work:**

1. Invoke the \`/dev3\` skill (or load \`~/.agents/skills/dev3/SKILL.md\` if skills are not supported).
2. Run \`~/.dev3.0/bin/dev3 task move --status in-progress\` at the START of every turn.
3. At the END of every turn, move the task to \`user-questions\` (need input) or \`review-by-user\` (fully complete). Never leave it in \`in-progress\`.

Do NOT skip these steps, even if the user gives a direct command.
${AGENTS_MD_MARKER_END}`;

/**
 * Ensure the dev3 block exists in ~/.agents/AGENTS.md.
 * Creates the file if missing; replaces an existing block if present;
 * appends if the file exists but has no dev3 block.
 */
function installAgentsMd(): void {
	const agentsDir = `${homedir()}/.agents`;
	const agentsFile = `${agentsDir}/AGENTS.md`;

	try {
		mkdirSync(agentsDir, { recursive: true });

		let content = "";
		try {
			content = readFileSync(agentsFile, "utf-8");
		} catch {
			// File doesn't exist yet — will create
		}

		if (content.includes(AGENTS_MD_MARKER_START)) {
			// Replace existing block
			const re = new RegExp(
				`${AGENTS_MD_MARKER_START}[\\s\\S]*?${AGENTS_MD_MARKER_END}`,
			);
			content = content.replace(re, AGENTS_MD_BLOCK);
		} else {
			// Append
			const separator = content.length > 0 && !content.endsWith("\n") ? "\n\n" : content.length > 0 ? "\n" : "";
			content = content + separator + AGENTS_MD_BLOCK + "\n";
		}

		writeFileSync(agentsFile, content, "utf-8");
		log.info("AGENTS.md updated", { path: agentsFile });
	} catch (err) {
		log.warn("Failed to update AGENTS.md (non-fatal)", {
			error: String(err),
		});
	}
}

const CLAUDE_BASH_PERMISSION = "Bash(~/.dev3.0/bin/dev3 *)";

/**
 * Ensure ~/.claude/settings.json has the dev3 CLI in permissions.allow
 * so Claude Code never prompts for approval on dev3 commands.
 */
function ensureClaudePermission(): void {
	const settingsPath = `${homedir()}/.claude/settings.json`;
	try {
		let settings: Record<string, unknown> = {};
		try {
			const raw = readFileSync(settingsPath, "utf-8");
			settings = JSON.parse(raw);
		} catch {
			// File doesn't exist or is invalid — start fresh
		}

		const permissions = (settings.permissions ?? {}) as Record<string, unknown>;
		const allow = Array.isArray(permissions.allow) ? (permissions.allow as string[]) : [];

		if (allow.includes(CLAUDE_BASH_PERMISSION)) {
			return; // Already present
		}

		allow.push(CLAUDE_BASH_PERMISSION);
		permissions.allow = allow;
		settings.permissions = permissions;

		writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
		log.info("Claude permission added", { pattern: CLAUDE_BASH_PERMISSION });
	} catch (err) {
		log.warn("Failed to update Claude settings (non-fatal)", {
			error: String(err),
		});
	}
}

/**
 * Install the dev3 skill into all supported AI agent directories
 * and update ~/.agents/AGENTS.md.
 * Overwritten on every app start to match the running version (same pattern as CLI binary).
 */
export function installAgentSkills(): void {
	const home = homedir();

	// Install Claude-specific skill (with command injection)
	const claudeSkillDir = `${home}/${CLAUDE_SKILL_DIR}`;
	const claudeSkillFile = `${claudeSkillDir}/SKILL.md`;
	try {
		mkdirSync(claudeSkillDir, { recursive: true });
		writeFileSync(claudeSkillFile, CLAUDE_SKILL_CONTENT, "utf-8");
		log.info("Claude skill installed", { path: claudeSkillFile });
	} catch (err) {
		log.warn("Failed to install Claude skill (non-fatal)", {
			path: claudeSkillFile,
			error: String(err),
		});
	}

	// Install generic skill for all other agents
	for (const dir of GENERIC_SKILL_DIRS) {
		const skillDir = `${home}/${dir}`;
		const skillFile = `${skillDir}/SKILL.md`;
		try {
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(skillFile, GENERIC_SKILL_CONTENT, "utf-8");
			log.info("Agent skill installed", { path: skillFile });
		} catch (err) {
			log.warn("Failed to install agent skill (non-fatal)", {
				path: skillFile,
				error: String(err),
			});
		}
	}

	installAgentsMd();
	ensureClaudePermission();
	ensureCodexConfigFile(home);
}
