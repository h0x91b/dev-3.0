import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createLogger } from "./logger";
import { ensureCodexConfigFile } from "./codex-config";

const log = createLogger("agent-skills");

// ---- Composable skill body sections ----

const SKILL_HEADER = `# dev3 — Task Lifecycle Protocol

You are working inside a **dev-3.0 managed worktree** with a Kanban board task assigned to you.
`;

const SKILL_BRANCH_NAMING = `
## Branch naming

After learning your current task, check if the branch matches \`dev3/task-*\` (opaque auto-generated name).
If it does, **rename it immediately** to something meaningful based on the task description:

\`\`\`bash
git branch -m dev3/task-XXXXXXXX <type>/<slug>
\`\`\`

> **User preferences override these defaults.** If the user's CLAUDE.md, AGENTS.md, or auto-memory
> specifies a different branch naming convention (e.g., JIRA ticket prefix, custom format),
> follow the user's convention instead of the defaults below.

**Default rules** (apply only when the user has no custom branch naming preference):
- Use a conventional type prefix: \`feat/\`, \`fix/\`, \`chore/\`, \`refactor/\`, \`docs/\`.
- Use lowercase kebab-case, 3-5 words: \`fix/auth-race-condition\`, \`feat/drag-reorder\`, \`refactor/rpc-handlers\`.
- Derive the slug from the task description/title — be concise but descriptive.

**Always applies:**
- If the branch already has a meaningful name (does NOT match \`dev3/task-*\`), skip renaming.
- If the branch was already pushed, also update the remote: \`git push origin :<old> && git push -u origin <new>\`.

Run this ONCE at session start, right after setting \`in-progress\`.
`;

const SKILL_TITLE_GENERATION = `
## Title generation

The task title is auto-generated from the first 80 characters of the description.
After learning your current task, if the title looks truncated (ends with "…") or is
longer than ~6 words, synthesize a concise title and update it:

  dev3 task update --title "Short imperative phrase"

Good titles: "Fix auth race condition", "Map missing keyboard bindings", "Add drag-to-reorder support"
Bad titles: copies of the description, vague summaries, titles with ellipsis
Run this ONCE at session start, before doing any other work.
`;

const SKILL_CUSTOM_COLUMNS = `
### Custom columns

If the project defines custom columns (visible in \`dev3 current\` output), you can move tasks there:

  dev3 task move --status <custom-column-id>

Each custom column has an 8-char ID prefix and a description of when to use it.
`;

const SKILL_NOTES = `
## Notes (per-task scratchpad)

Use \`dev3 note add "..."\` to record important findings, decisions, or context. Notes survive worktree destruction — they are valuable for continuity. Keep them concise and useful; don't flood with noise, but do log key insights that would help if someone revisits the task later.
`;

// Full manual status management — for agents without hooks (Cursor, Codex, Gemini, etc.)
const SKILL_STATUS_MANUAL = `
## Task status management (CRITICAL — NON-NEGOTIABLE)

### Status transitions — every turn:

1. **Start of every turn** — run \`~/.dev3.0/bin/dev3 task move --status in-progress\` when you receive a message and begin working.
2. **End of every turn** — before your final response, you MUST move the task to one of exactly two states:
   - **\`user-questions\`** — you need user input, clarification, or the ball is on the user's side for any reason. **This is the default if the task is not yet complete.** (shown in UI as "Has Questions")
   - **\`review-by-user\`** — you believe the task is fully complete from your side.
3. **\`in-progress\` is transient** — it MUST NEVER remain after you finish responding. It only exists while you are actively working. (shown in UI as "Agent is Working")

### Rules:

- If \`task move\` fails because the task is already in the target status, that is OK — just continue.
${SKILL_CUSTOM_COLUMNS}`;

// Simplified status management — for Claude Code (hooks handle everything automatically)
const SKILL_STATUS_HOOKS = `
## Task status management

Hooks automatically manage task status transitions (\`in-progress\`, \`user-questions\`, \`review-by-user\`).
Do NOT call \`dev3 task move\` for status changes — hooks handle it. You can still use it for custom columns.
${SKILL_CUSTOM_COLUMNS}`;

const SKILL_CODEX_SHELL = `
## Codex shell note

For \`exec_command\` calls, always set \`shell="/bin/bash"\` and \`login=false\`. Do not trust the ambient shell metadata — the sandbox may resolve to an unavailable shell binary (e.g. homebrew zsh blocked by seatbelt).
`;

// Composed bodies for each agent type
const CLAUDE_SKILL_BODY = SKILL_HEADER + SKILL_BRANCH_NAMING + SKILL_TITLE_GENERATION + SKILL_STATUS_HOOKS + SKILL_NOTES;
const GENERIC_SKILL_BODY = SKILL_HEADER + SKILL_BRANCH_NAMING + SKILL_TITLE_GENERATION + SKILL_STATUS_MANUAL + SKILL_NOTES + SKILL_CODEX_SHELL;

const SKILL_DESCRIPTION = "MANDATORY — invoke BEFORE doing anything else. Trigger: your working directory (PWD) is inside ~/.dev3.0/worktrees/ (i.e. $HOME/.dev3.0/worktrees/). Regular git worktrees or other worktree paths do NOT qualify — only the dev-3.0 managed path. Step 1: invoke this skill (for Codex exec_command calls, always set shell=\\\"/bin/bash\\\" and login=false). Step 2: handle the user's request. NEVER skip step 1, even if the user gives a direct command.";

// ---- Claude Code skill (uses !`command` injection for zero tool calls at startup) ----

const CLAUDE_SKILL_CONTENT = `---
name: dev3
description: "${SKILL_DESCRIPTION}"
user-invocable: true
---

${CLAUDE_SKILL_BODY}
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

${GENERIC_SKILL_BODY}
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

// ---- dev3-project-config skill ----

const PROJECT_CONFIG_SKILL_DESCRIPTION =
	"Use when you need to create, read, or modify a dev-3.0 project config file (.dev3/config.json or .dev3/config.local.json). Trigger: the user asks to configure project settings, you see a .dev3/ directory, or the task involves setup/dev/cleanup scripts, clone paths, base branch, or peer review settings.";

const PROJECT_CONFIG_SKILL_BODY = `# dev3-project-config — Project Configuration Files

## What is .dev3/config.json?

The **primary source of project settings** for dev-3.0. This file is committed to git,
letting the whole team share project configuration (scripts, clone paths, base branch)
without manual per-machine setup.

## File locations

| File | Committed? | Purpose |
|------|-----------|---------|
| \`.dev3/config.json\` | Yes (git) | Primary project settings — shared with the team |
| \`.dev3/config.local.json\` | No (git-ignored) | Machine-specific overrides |

## Merge priority (lowest → highest)

1. **Repo** — \`.dev3/config.json\` (committed, shared via git)
2. **Local** — \`.dev3/config.local.json\` (git-ignored, personal overrides)

Fields not set in either file use defaults (empty string / empty array / "main" / true).

**Important:** Settings in \`~/.dev3.0/projects.json\` are NOT used for scripts/config.
That file only stores project metadata (id, name, path). All settings live in \`.dev3/\`.

## Schema

All fields are **optional**. Only include fields you want to set.

\`\`\`json
{
  "setupScript": "bun install",
  "devScript": "bun run dev",
  "cleanupScript": "rm -rf node_modules/.cache",
  "clonePaths": ["node_modules", ".next"],
  "defaultBaseBranch": "main",
  "peerReviewEnabled": true
}
\`\`\`

### Field reference

| Field | Type | Description |
|-------|------|-------------|
| \`setupScript\` | string | Runs after a new worktree is created for a task |
| \`devScript\` | string | Dev server command (reserved for future use) |
| \`cleanupScript\` | string | Runs when a task is cancelled or archived |
| \`clonePaths\` | string[] | Paths to copy (not symlink) into new worktrees (e.g. \`node_modules\`) |
| \`defaultBaseBranch\` | string | Base branch for new task branches (default: \`main\`) |
| \`peerReviewEnabled\` | boolean | Whether peer review is required before completing tasks |

## When to create .dev3/config.json

- The user asks to configure project settings
- You are setting up a new project and know the correct scripts/paths
- The user asks to share settings with the team

## When to use .dev3/config.local.json

- Machine-specific paths (e.g. absolute paths that differ per developer)
- Personal preferences that shouldn't be shared
- Temporary overrides during development

## Choosing repo vs local — ask the user

When the user asks to save or change project settings, **always ask** whether they want
to save to the repo config (shared with team) or local config (this machine only):

- "Where should I save this — to the repo config (shared) or local (just for you)?"
- Default to \`.dev3/config.json\` (repo) for most settings
- Use \`.dev3/config.local.json\` only when the user explicitly wants a personal override

## How to create

1. Create the \`.dev3/\` directory if it doesn't exist
2. Write the config file as pretty-printed JSON
3. If creating \`.dev3/config.local.json\`, ensure it's in \`.gitignore\`

\`\`\`bash
mkdir -p .dev3
cat > .dev3/config.json << 'EOF'
{
  "setupScript": "bun install",
  "defaultBaseBranch": "main"
}
EOF
\`\`\`

## .gitignore

\`.dev3/config.local.json\` must be git-ignored. The app does this automatically,
but if creating manually, add this to \`.gitignore\`:

\`\`\`
# dev-3.0 local config
.dev3/config.local.json
\`\`\`

## CLI commands

- \`dev3 config show\` — display effective merged settings with source indicators
- \`dev3 config export\` — migrate settings from projects.json to \`.dev3/config.json\`

## Important notes

- **Do NOT include non-config fields** (id, name, path, createdAt) — only the 6 fields above are valid
- **Unknown keys are silently ignored** by the merge logic
- The app UI has two tabs: "Repo Config" and "Local Overrides"
- Changes to \`.dev3/config.json\` take effect immediately on next app refresh (no restart needed)
`;

const CLAUDE_PROJECT_CONFIG_SKILL = `---
name: dev3-project-config
description: "${PROJECT_CONFIG_SKILL_DESCRIPTION}"
---

${PROJECT_CONFIG_SKILL_BODY}`;

const GENERIC_PROJECT_CONFIG_SKILL = `---
name: dev3-project-config
description: "${PROJECT_CONFIG_SKILL_DESCRIPTION}"
---

${PROJECT_CONFIG_SKILL_BODY}`;

/** Claude Code project-config skill directory. */
const CLAUDE_PROJECT_CONFIG_DIR = ".claude/skills/dev3-project-config";

/** Generic agent project-config skill directories. */
const GENERIC_PROJECT_CONFIG_DIRS = [
	".cursor/skills/dev3-project-config",
	".agents/skills/dev3-project-config",
	".codex/skills/dev3-project-config",
	".gemini/skills/dev3-project-config",
	".opencode/skills/dev3-project-config",
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

**Codex shell note:** For \`exec_command\` calls, always set \`shell="/bin/bash"\` and \`login=false\`. The sandbox may block homebrew zsh.
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

	// Install Claude-specific project-config skill
	const claudeProjectConfigDir = `${home}/${CLAUDE_PROJECT_CONFIG_DIR}`;
	const claudeProjectConfigFile = `${claudeProjectConfigDir}/SKILL.md`;
	try {
		mkdirSync(claudeProjectConfigDir, { recursive: true });
		writeFileSync(claudeProjectConfigFile, CLAUDE_PROJECT_CONFIG_SKILL, "utf-8");
		log.info("Claude project-config skill installed", { path: claudeProjectConfigFile });
	} catch (err) {
		log.warn("Failed to install Claude project-config skill (non-fatal)", {
			path: claudeProjectConfigFile,
			error: String(err),
		});
	}

	// Install generic project-config skill for all other agents
	for (const dir of GENERIC_PROJECT_CONFIG_DIRS) {
		const skillDir = `${home}/${dir}`;
		const skillFile = `${skillDir}/SKILL.md`;
		try {
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(skillFile, GENERIC_PROJECT_CONFIG_SKILL, "utf-8");
			log.info("Agent project-config skill installed", { path: skillFile });
		} catch (err) {
			log.warn("Failed to install agent project-config skill (non-fatal)", {
				path: skillFile,
				error: String(err),
			});
		}
	}

	installAgentsMd();
	ensureClaudePermission();
	ensureCodexConfigFile(home);
}
