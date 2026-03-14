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

const SKILL_PROJECT_CONFIG_REDIRECT = `
## Project configuration (.dev3/config.json)

For ANY question about project configuration — setting up scripts (setup, dev, cleanup), clone paths, base branch, sparse checkout, or anything related to \`.dev3/config.json\` / \`.dev3/config.local.json\` — you MUST invoke the \`/dev3-project-config\` skill. Do NOT attempt to configure the project without it. The dedicated skill knows the full schema, auto-detection logic, and correct workflow.
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
const CLAUDE_SKILL_BODY = SKILL_HEADER + SKILL_BRANCH_NAMING + SKILL_TITLE_GENERATION + SKILL_STATUS_HOOKS + SKILL_NOTES + SKILL_PROJECT_CONFIG_REDIRECT;
const GENERIC_SKILL_BODY = SKILL_HEADER + SKILL_BRANCH_NAMING + SKILL_TITLE_GENERATION + SKILL_STATUS_MANUAL + SKILL_NOTES + SKILL_PROJECT_CONFIG_REDIRECT + SKILL_CODEX_SHELL;

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

const PROJECT_CONFIG_SKILL_BODY = `# dev3-project-config — Automated Project Setup

## Your job

When invoked, **fully configure the project** by analyzing it and writing \`.dev3/config.json\`.
Do NOT ask the user what to put in each field — figure it out yourself. Only ask if something
is genuinely ambiguous (e.g., multiple possible dev servers, unclear base branch).

## Step-by-step

1. **Check if \`.dev3/config.json\` already exists.** If it does and all fields are populated, tell the user it's already configured and stop (unless they asked to change something specific).

2. **Analyze the project.** Read these files (whichever exist):
   - \`package.json\` — scripts, dependencies, devDependencies, workspaces
   - \`Makefile\` / \`Justfile\` — build targets
   - \`pyproject.toml\` / \`setup.py\` / \`requirements.txt\` — Python projects
   - \`Cargo.toml\` — Rust projects
   - \`go.mod\` — Go projects
   - \`.gitignore\` — hints about build artifacts and deps
   - \`docker-compose.yml\` / \`Dockerfile\` — container-based dev
   - Root-level config files (\`vite.config.*\`, \`next.config.*\`, \`turbo.json\`, etc.)

3. **Determine all config fields:**

   | Field | How to determine |
   |-------|-----------------|
   | \`setupScript\` | Package manager install command. Detect from lockfile: \`bun.lockb\` → \`bun install\`, \`pnpm-lock.yaml\` → \`pnpm install\`, \`yarn.lock\` → \`yarn\`, \`package-lock.json\` → \`npm install\`. For Python: \`pip install -e .\` or \`poetry install\`. For Rust: \`cargo build\`. Chain multiple steps with \`&&\` if needed. |
   | \`devScript\` | The dev server command. Check \`package.json\` scripts for \`dev\`, \`start\`, \`serve\`. Use the full command: \`bun run dev\`, \`npm run dev\`, etc. If no dev server exists, leave empty. |
   | \`cleanupScript\` | Clean build artifacts and caches. E.g., \`rm -rf node_modules/.cache dist .next\`. Tailor to what the project actually generates. If unsure, leave empty. |
   | \`clonePaths\` | Heavy directories that should be CoW-cloned into new worktrees instead of re-downloaded. Common: \`node_modules\`, \`.venv\`, \`target\`, \`.next\`, \`build\`. Only include dirs that actually exist in the project. |
   | \`defaultBaseBranch\` | Check \`git symbolic-ref refs/remotes/origin/HEAD\` or look at common branches. Usually \`main\` or \`master\`. |
   | \`peerReviewEnabled\` | Default \`true\`. Only set \`false\` for personal/solo projects. |

4. **Ask where to save.** Stop and ask clearly: "Repo config (shared, git) or Local config (personal, git-ignored)?" — wait for answer before writing anything.

\`\`\`bash
mkdir -p .dev3
cat > .dev3/config.json << 'EOF'
{
  "setupScript": "bun install",
  "devScript": "bun run dev",
  "cleanupScript": "rm -rf dist node_modules/.cache",
  "clonePaths": ["node_modules"],
  "defaultBaseBranch": "main"
}
EOF
\`\`\`

5. **Run the setupScript once.** Execute it right now in your shell to install dependencies / generate files. This validates the script works and also produces the heavy directories (node_modules, .venv, etc.) needed for the next step.

6. **Update clonePaths after setup.** After the setupScript finishes, check which heavy directories now exist (node_modules, .venv, target, build, dist, .next, etc.) and add any missing ones to \`clonePaths\` in the config. Re-write the config if needed.

7. **Verify** by running \`dev3 config show\` and confirm all fields show the correct source.

8. **Commit** the config file: \`git add .dev3/config.json && git commit -m "chore: add dev3 project config"\`

## Schema reference

| Field | Type | Description |
|-------|------|-------------|
| \`setupScript\` | string | Runs after a new worktree is created (install deps, generate code, etc.) |
| \`devScript\` | string | Dev server command (powers the "Dev Server" button in the UI) |
| \`cleanupScript\` | string | Runs when a task is cancelled or archived |
| \`clonePaths\` | string[] | Dirs to CoW-clone into worktrees (faster than re-downloading) |
| \`defaultBaseBranch\` | string | Base branch for new task branches (default: \`main\`) |
| \`peerReviewEnabled\` | boolean | Whether peer review is required (default: \`true\`) |
| \`sparseCheckoutEnabled\` | boolean | Enable sparse checkout for worktrees (default: \`false\`) |
| \`sparseCheckoutPaths\` | string[] | Paths to include in sparse checkout |

**Only include these fields.** Unknown keys are silently ignored. Do NOT include project metadata (id, name, path).

## Files

| File | Committed? | Purpose |
|------|-----------|---------|
| \`.dev3/config.json\` | Yes | Shared project settings (team-wide) |
| \`.dev3/config.local.json\` | No (git-ignored) | Machine-specific overrides (personal) |

**Always ask the user** which file to save to before writing. Suggest repo config as default.

## CLI commands

- \`dev3 config show\` — display effective config with source per field
- \`dev3 config export\` — migrate legacy settings from projects.json
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
