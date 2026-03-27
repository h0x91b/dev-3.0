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
- Type prefixes: \`feat/dev3-\`, \`fix/dev3-\`, \`chore/dev-3\`, \`refactor/dev3-\`, \`docs/dev3-\`.
- Use lowercase kebab-case for the slug (3-5 words): \`fix/dev3-auth-race-condition\`, \`feat/dev3-drag-reorder\`, \`refactor/dev3-rpc-handlers\`.
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

// Full manual status management — for agents without hooks (Cursor, Gemini, etc.)
const SKILL_STATUS_MANUAL = `
## Task status management (CRITICAL — NON-NEGOTIABLE)

### Status transitions — every turn:

1. **Start of every turn** — run \`~/.dev3.0/bin/dev3 task move --status in-progress --if-status-not review-by-ai\` when you receive a message and begin working.
2. **End of every turn** — before your final response, you MUST move the task to one of exactly two states:
   - **\`user-questions\`** — you need user input, clarification, or the ball is on the user's side for any reason. **This is the default if the task is not yet complete.** (shown in UI as "Has Questions")
   - **\`review-by-user\`** — you believe the task is fully complete from your side. (shown in UI as "Your Review")
3. **\`in-progress\` is transient** — it MUST NEVER remain after you finish responding. It only exists while you are actively working. (shown in UI as "Agent is Working")

### Rules:

- If \`task move\` fails because the task is already in the target status, that is OK — just continue.
${SKILL_CUSTOM_COLUMNS}`;

// Simplified status management — for Claude Code (hooks handle everything automatically)
const SKILL_STATUS_HOOKS = `
## Task status management

Hooks automatically manage task status transitions (\`in-progress\`, \`user-questions\`, \`review-by-ai\`, \`review-by-user\`).
Do NOT call \`dev3 task move\` for status changes — hooks handle it. On projects with Automatic AI Review enabled, completed work passes through \`review-by-ai\` before \`review-by-user\`. You can still use \`dev3 task move\` for custom columns.
${SKILL_CUSTOM_COLUMNS}`;

// Codex also uses hooks, but the session must be restarted after config changes.
const SKILL_STATUS_CODEX_HOOKS = `
## Task status management

Hooks automatically manage task status transitions (\`in-progress\`, \`review-by-ai\`, \`review-by-user\`) for Codex sessions started after the dev3 config was installed.
Do NOT call \`dev3 task move\` for normal active/review transitions when hooks are active. If you need user input or clarification, move the task to \`user-questions\` before your final response. If you are in an older Codex session where hooks clearly are not firing yet, fall back to manual status management: move to \`in-progress\` when you start, \`user-questions\` when blocked, and \`review-by-user\` when finished.
${SKILL_CUSTOM_COLUMNS}`;

const SKILL_CODEX_SHELL = `
## Codex shell note

For \`exec_command\` calls, always set \`shell="/bin/bash"\` and \`login=false\`. Do not trust the ambient shell metadata — the sandbox may resolve to an unavailable shell binary (e.g. homebrew zsh blocked by seatbelt).
`;

// Composed bodies for each agent type
const CLAUDE_SKILL_BODY = SKILL_HEADER + SKILL_BRANCH_NAMING + SKILL_TITLE_GENERATION + SKILL_STATUS_HOOKS + SKILL_NOTES + SKILL_PROJECT_CONFIG_REDIRECT;
const CODEX_SKILL_BODY = SKILL_HEADER + SKILL_BRANCH_NAMING + SKILL_TITLE_GENERATION + SKILL_STATUS_CODEX_HOOKS + SKILL_NOTES + SKILL_PROJECT_CONFIG_REDIRECT + SKILL_CODEX_SHELL;
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

!\`~/.dev3.0/bin/dev3 task move --status in-progress --if-status-not review-by-ai 2>&1\`

## CLI reference

\\\`\\\`\\\`
!\`~/.dev3.0/bin/dev3 --help\`
\\\`\\\`\\\`

## Your current task

\\\`\\\`\\\`
!\`~/.dev3.0/bin/dev3 current\`
\\\`\\\`\\\`
`;

// ---- Codex and generic skills (no command injection support) ----

const CODEX_SKILL_CONTENT = `---
name: dev3
description: "${SKILL_DESCRIPTION}"
user-invocable: true
---

${CODEX_SKILL_BODY}
## On session start

Run these two commands to learn about available CLI commands and your current task:

- \`~/.dev3.0/bin/dev3 --help\` — learn all available CLI commands
- \`~/.dev3.0/bin/dev3 current\` — see your current project, task, and status

Then begin working. If hooks are not active in this Codex session yet, set \`in-progress\` manually and continue.
`;

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

/** Codex skill directory (hook-aware, but no command injection support). */
const CODEX_SKILL_DIR = ".codex/skills/dev3";

/** Generic agent skill directories (no command injection support). */
const GENERIC_SKILL_DIRS = [
	".cursor/skills/dev3",
	".agents/skills/dev3",
	".gemini/skills/dev3",
	".opencode/skills/dev3",
	".config/opencode/skills/dev3",
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
   | \`defaultCompareRefMode\` | Default diff comparison target. Use \`"remote"\` for \`origin/<baseBranch>\` (recommended default) or \`"local"\` for the local base branch. |
   | \`peerReviewEnabled\` | Default \`true\`. Only set \`false\` for personal/solo projects. |
   | \`portCount\` | Number of ports to auto-allocate per task/worktree. Set to 0 (default) to disable. Inspect the codebase and dev/runtime configuration to estimate how many concurrent ports the dev stack needs (e.g., frontend + backend + DB = 3). Common sources include app start scripts, compose files, container configs, process managers, and framework config files. **Setting portCount alone is NOT enough** — you MUST also complete step 3a (port mapping) to wire the allocated ports into the project. |

3a. **Port discovery & mapping (MANDATORY when portCount > 0).**
   \`portCount\` only allocates ports — the project won't use them until you wire them into its own env vars.
   Dev3 injects: \`$DEV3_PORT0\`, \`$DEV3_PORT1\`, … \`$DEV3_PORTS\` (comma-separated), \`$DEV3_PORT_COUNT\`.
   The project has its **own** port env vars (e.g., \`VITE_PORT\`, \`PORT\`, \`API_PORT\`). You must bridge them.

   **Research steps (do this BEFORE writing the config):**
   - Search the codebase for port-related env vars and hardcoded port numbers (patterns: \`PORT\`, \`localhost:\`, \`127.0.0.1:\`, \`0.0.0.0:\`)
   - Check app start commands and dev scripts for port references (\`--port\`, \`PORT=\`, \`localhost:XXXX\`). For example: \`package.json\` scripts, Make targets, shell scripts, Procfiles, npm/bun/pnpm task runners.
   - Check project config and infrastructure files for port settings. For example: \`vite.config.*\`, \`next.config.*\`, \`webpack.config.*\`, compose files, Docker files, \`.env.example\`, service configs.
   - Identify which env var controls each port and what its default value is
   - For every mapping, record the exact evidence from this repo (file + env var/flag), e.g. "\`vite.config.ts\` reads \`process.env.VITE_PORT\`"
   - Do NOT infer env vars from the framework name alone. Only map env vars or CLI flags you actually found in this project.

   **Wire ports in \`devScript\`.** Prepend env var assignments using \`\${DEV3_PORTx:-default}\` syntax so dev3's allocated port is forwarded to the project's own env var:
   \`\`\`
   "devScript": "VITE_PORT=\${DEV3_PORT0:-5173} API_PORT=\${DEV3_PORT1:-3001} bun run dev"
   \`\`\`
   The \`:-default\` fallback ensures the command still works when run manually (outside dev3).

   Before writing the config, briefly state the evidence for each mapping in your response so the user can verify it.
   If you cannot find an explicit port override mechanism in this project, do NOT guess with a generic \`PORT=\` assignment. Set \`portCount: 0\` and explain why.

4. **Ask where to save.** Stop and ask clearly: "Repo config (shared, git) or Local config (personal, git-ignored)?" — wait for answer before writing anything.

\`\`\`bash
mkdir -p .dev3
cat > .dev3/config.json << 'EOF'
{
  "setupScript": "bun install",
  "devScript": "VITE_PORT=\${DEV3_PORT0:-5173} API_PORT=\${DEV3_PORT1:-3001} bun run dev",
  "cleanupScript": "rm -rf dist node_modules/.cache",
  "clonePaths": ["node_modules"],
  "defaultBaseBranch": "main",
  "defaultCompareRefMode": "remote",
  "portCount": 2
}
EOF
\`\`\`

5. **Run the setupScript once.** Execute it right now in your shell to install dependencies / generate files. This validates the script works and also produces the heavy directories (node_modules, .venv, etc.) needed for the next step.

6. **Update clonePaths after setup.** After the setupScript finishes, check which heavy directories now exist (node_modules, .venv, target, build, dist, .next, etc.) and add any missing ones to \`clonePaths\` in the config. Re-write the config if needed.

7. **Verify** by running \`dev3 config show\` and confirm all fields show the correct source. If \`portCount > 0\`, also smoke-test the mapping: run the dev command briefly with explicit \`DEV3_PORT0\` (and others if needed) and confirm the project uses the forwarded port. If a smoke test is impractical, say so explicitly.

8. **Commit** the config file: \`git add .dev3/config.json && git commit -m "chore: add dev3 project config"\`

## Schema reference

| Field | Type | Description |
|-------|------|-------------|
| \`setupScript\` | string | Runs after a new worktree is created (install deps, generate code, etc.) |
| \`devScript\` | string | Dev server command (powers the "Dev Server" button in the UI) |
| \`cleanupScript\` | string | Runs when a task is cancelled or archived |
| \`clonePaths\` | string[] | Dirs to CoW-clone into worktrees (faster than re-downloading) |
| \`defaultBaseBranch\` | string | Base branch for new task branches (default: \`main\`) |
| \`defaultCompareRefMode\` | \`"remote" \| "local"\` | Default diff comparison target (\`origin/<baseBranch>\` vs local base branch) |
| \`peerReviewEnabled\` | boolean | Whether peer review is required (default: \`true\`) |
| \`sparseCheckoutEnabled\` | boolean | Enable sparse checkout for worktrees (default: \`false\`) |
| \`sparseCheckoutPaths\` | string[] | Paths to include in sparse checkout |
| \`portCount\` | number | Ports to allocate per task (injected as \`DEV3_PORT0\`..N env vars). Default: \`0\`. **You must map these to the project's own port env vars in \`devScript\` — see step 3a.** |

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

export function getProjectConfigSkillContent(): string {
	return PROJECT_CONFIG_SKILL_BODY;
}

/** Claude Code project-config skill directory. */
const CLAUDE_PROJECT_CONFIG_DIR = ".claude/skills/dev3-project-config";

/** Generic agent project-config skill directories. */
const GENERIC_PROJECT_CONFIG_DIRS = [
	".cursor/skills/dev3-project-config",
	".agents/skills/dev3-project-config",
	".codex/skills/dev3-project-config",
	".gemini/skills/dev3-project-config",
	".opencode/skills/dev3-project-config",
	".config/opencode/skills/dev3-project-config",
];

// ---- ~/.agents/AGENTS.md rule block ----

const AGENTS_MD_MARKER_START = "<!-- dev3:start -->";
const AGENTS_MD_MARKER_END = "<!-- dev3:end -->";

const AGENTS_MD_BLOCK = `${AGENTS_MD_MARKER_START}
## dev-3.0 Managed Worktree

If your working directory (PWD) is inside \`~/.dev3.0/worktrees/\` (i.e. \`$HOME/.dev3.0/worktrees/\`), you are a **dev-3.0 managed AI agent** with a Kanban task assigned. Regular git worktrees or other paths containing "worktrees" do **NOT** qualify — only the dev-3.0 managed directory under the user's home.

**MANDATORY — do this BEFORE any other work:**

1. Invoke the \`/dev3\` skill (or load \`~/.agents/skills/dev3/SKILL.md\` if skills are not supported).
2. Run \`~/.dev3.0/bin/dev3 task move --status in-progress --if-status-not review-by-ai\` at the START of every turn.
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

	// Install Codex-specific skill (hook-aware + shell note)
	const codexSkillDir = `${home}/${CODEX_SKILL_DIR}`;
	const codexSkillFile = `${codexSkillDir}/SKILL.md`;
	try {
		mkdirSync(codexSkillDir, { recursive: true });
		writeFileSync(codexSkillFile, CODEX_SKILL_CONTENT, "utf-8");
		log.info("Codex skill installed", { path: codexSkillFile });
	} catch (err) {
		log.warn("Failed to install Codex skill (non-fatal)", {
			path: codexSkillFile,
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
