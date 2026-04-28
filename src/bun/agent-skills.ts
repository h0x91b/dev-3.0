import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

When targeting a task other than the auto-detected current worktree task, pass
\`--task <id>\` or \`--task-id <id>\` explicitly. This works for \`task show\`,
\`task update\`, \`task move\`, \`note\`, \`overview\`, and \`label set\`.

In the same session-start pass, also assign task labels:

- Run \`dev3 label list\` and reuse existing labels whenever possible.
- Aim for **1-2 meaningful labels per task** in the normal case.
- If the task still needs a label and there is no good fit, create **one short reusable label** with \`dev3 label create "name"\` and attach it to the current task immediately.
- Apply the final label set with \`dev3 label set <id> [<id>...]\`. Creating a label without attaching it does **not** complete this step.
- If the task already has sensible labels, leave them alone unless they are clearly wrong or incomplete.
- Do not spam labels, create near-duplicates, or use labels for workflow state (\`in-progress\`, \`review\`, \`blocked\`, etc.).

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

const SKILL_OVERVIEW = `
## Overview (MANDATORY)

Every task MUST have a one-paragraph \`overview\` written by you. The \`description\` field is the **original user request** (often long, messy) — it's NOT a substitute for \`overview\`. The overview is a concise, clean summary that lets the user re-enter focus in 5 seconds after not touching the task for days.

**Language — IMPORTANT:** Write the overview in the **same language the user is using with you in this task**. If the user writes in Russian, the overview is in Russian. If in Spanish, in Spanish. If in English, in English. Look at the task \`description\` and the user's messages in this session — match that language. Do NOT default to English.

**When to set it:**
- Within the first minute after starting a task — write an initial overview based on what you understood
- Re-set it whenever the direction changes materially
- Refresh it roughly every 5 user↔agent exchanges so it stays current (easy to forget otherwise)

**How:**

    dev3 overview set "One clean paragraph, in the user's language. What the task is about and current state."

Keep it under ~400 chars. Plain text, no markdown headers. Think: "what would the user want to read in a hover tooltip on day 3, in their own language?"
`;

const SKILL_DEV_SERVER_CONTROL = `
## Dev Server Control

\`dev3 dev-server status\` is low-risk and may be used when relevant.

\`dev3 dev-server start\`, \`restart\`, and \`stop\` have visible side effects.
Do not use them by default.

Use them only when:
- the user explicitly asked for dev-server control
- the task is about \`devScript\`, ports, or dev-server behavior
- you need the dev server running to verify the change

Before doing so, briefly tell the user what you are about to do.

Prefer \`status\` before \`start\` to avoid unnecessary restarts.
If you started the dev server only for verification, stop it afterwards unless the user asked to keep it running.
`;

const SKILL_PROJECT_CONFIG_REDIRECT = `
## Project configuration (.dev3/config.json)

For ANY question about project configuration — setting up scripts (setup, dev, cleanup), clone paths, base branch, sparse checkout, or anything related to \`.dev3/config.json\` / \`.dev3/config.local.json\` — you MUST invoke the \`/dev3-project-config\` skill. Do NOT attempt to configure the project without it. The dedicated skill knows the full schema, auto-detection logic, and correct workflow.
`;

const SKILL_SCRATCH_TASK = `
## Scratch tasks

If your task title starts with \`Scratch — \` (e.g. \`Scratch — 14:32\`), the user clicked "Scratch Task" in the UI instead of writing a prompt. There is no initial instruction for you. The task \`description\` is just the placeholder title — it is NOT the real request.

What to do:

1. Greet the user briefly in one short line and ask what they want to do.
2. As soon as they tell you, immediately:
   - \`dev3 task update --title "<concise imperative>"\` — replace the placeholder with a real title.
   - Set a proper overview (per the Overview rules above).
   - \`dev3 label set <id> [<id>...]\` — pick 1-2 meaningful labels (see Title generation rules above).
3. Treat the first real user message as the task description and proceed as normal.
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
//
// These are also injected directly into the agent's system prompt via
// --append-system-prompt (Claude) or the prompt argument (Codex / Cursor /
// OpenCode), so the skill rules are always in context regardless of whether
// the agent decides to load the skill file. See `DEV3_SYSTEM_PROMPT*` in
// `agents.ts`.
export const CLAUDE_SKILL_BODY = SKILL_HEADER + SKILL_BRANCH_NAMING + SKILL_TITLE_GENERATION + SKILL_STATUS_HOOKS + SKILL_OVERVIEW + SKILL_SCRATCH_TASK + SKILL_NOTES + SKILL_DEV_SERVER_CONTROL + SKILL_PROJECT_CONFIG_REDIRECT;
export const CODEX_SKILL_BODY = SKILL_HEADER + SKILL_BRANCH_NAMING + SKILL_TITLE_GENERATION + SKILL_STATUS_CODEX_HOOKS + SKILL_OVERVIEW + SKILL_SCRATCH_TASK + SKILL_NOTES + SKILL_DEV_SERVER_CONTROL + SKILL_PROJECT_CONFIG_REDIRECT + SKILL_CODEX_SHELL;
export const GENERIC_SKILL_BODY = SKILL_HEADER + SKILL_BRANCH_NAMING + SKILL_TITLE_GENERATION + SKILL_STATUS_MANUAL + SKILL_OVERVIEW + SKILL_SCRATCH_TASK + SKILL_NOTES + SKILL_DEV_SERVER_CONTROL + SKILL_PROJECT_CONFIG_REDIRECT + SKILL_CODEX_SHELL;

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
	".opencode/skills/dev3",
	".config/opencode/skills/dev3",
];

const DEV3_OPENAI_YAML = `interface:
  display_name: "dev3"
  short_description: "Manage dev-3.0 task lifecycle inside managed worktrees"
  default_prompt: "Use $dev3 when working inside a dev-3.0 managed worktree so task lifecycle rules are followed."
`;

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
   | \`cleanupScript\` | Teardown hook that runs before the task worktree is removed after \`completed\` or \`cancelled\`. Useful for copy-back, exports, and cache cleanup. Inside the script you can branch on \`$DEV3_TASK_STATUS\`, \`$DEV3_TASK_FROM_STATUS\`, and \`$DEV3_TASK_TO_STATUS\`. |
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
| \`cleanupScript\` | string | Runs before the task worktree is removed after \`completed\` or \`cancelled\` |
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

const PROJECT_CONFIG_OPENAI_YAML = `interface:
  display_name: "dev3 Project Config"
  short_description: "Inspect a repo and configure dev-3.0 project settings"
  default_prompt: "Use $dev3-project-config to inspect a repo and configure .dev3 project settings."
`;

// ---- dev3 Bug Hunter skill ----

const BUG_HUNTER_SKILL_DESCRIPTION =
	"Use when the user wants a focused bug-hunting pass, especially in dev-3.0 where multiple task variants can explore the same codebase in parallel. Runs a seeded initialization sequence that assigns each agent a letter, a starting area, and an analysis style before it begins hunting.";

const BUG_HUNTER_SKILL_CONTENT = `---
name: dev3-bug-hunter
description: "${BUG_HUNTER_SKILL_DESCRIPTION}"
user-invocable: true
---

# dev3-bug-hunter

You are a bug-finding agent. Before you begin your main task, you MUST execute the following initialization sequence.

## Scope

This skill is review-only.

- Do NOT modify code, apply patches, create commits, or rewrite files.
- Do NOT silently fix anything yourself.
- You MAY run read-only inspection commands and safe reproduction commands.
- You MAY create dev3 tasks only after the user explicitly approves task creation for findings.
- If a bug looks real but is not yet proven, say so plainly and describe the missing proof.

## Prerequisite

If your working directory is inside \`~/.dev3.0/worktrees/\`, invoke the \`/dev3\` skill before doing anything else unless it is already active in the session. For Codex shell commands, use \`shell="/bin/bash"\` and \`login=false\`.

## Step 1: Generate your seed

Run this command:

\`\`\`bash
echo $(od -An -N2 -tu2 /dev/urandom | tr -d ' ')
\`\`\`

## Step 2: Derive your exploration letter

Take the number you received and compute \`letter_index = seed % 26\`.

Map it to a letter:

- \`0 = A\`
- \`1 = B\`
- ...
- \`25 = Z\`

This is your agent identity letter.

## Step 3: Derive your exploration strategy

Compute \`strategy = seed % 6\`.

| strategy | Start from |
|----------|------------|
| 0 | Entry points: main files, index files, app bootstrap |
| 1 | Edge cases: error handlers, catch blocks, fallbacks |
| 2 | Data layer: models, schemas, DB queries, migrations |
| 3 | Integration seams: API boundaries, external calls, webhooks |
| 4 | User-facing: UI components, form validation, rendering logic |
| 5 | Infrastructure: config, env handling, build scripts, CI |

You MUST begin from your assigned area. Do not jump to other areas until you have examined yours thoroughly.

## Step 4: Derive your analysis style

Compute \`style = floor(seed / 6) % 4\` using integer division.

| style | Approach |
|-------|----------|
| 0 | Pessimist: assume everything is broken, prove otherwise |
| 1 | Trace-follower: pick a user flow and trace it end-to-end |
| 2 | Dependency skeptic: check assumptions between modules |
| 3 | Fresh eyes: read code as if seeing it for the first time, question naming and logic |

## Step 5: Announce your identity

Before reporting findings, print exactly one line in this format:

\`\`\`text
Agent [LETTER] | Strategy: [name] | Style: [name] | Seed: [number]
\`\`\`

## Step 6: Hunt for bugs

Start from the area assigned by your strategy and apply the seeded style consistently.

Focus on:

- Logic errors and off-by-one mistakes
- Unhandled edge cases
- Race conditions and async issues
- Security vulnerabilities
- Silent failures and swallowed errors
- Type mismatches and implicit coercions

Prefer concrete, reproducible bugs over vague suspicions. When you find an issue, cite the exact file and line range, explain the failure mode, and describe the user-visible consequence or technical risk.

## Required output format

After the identity line, use these sections in order:

### Findings summary

Use a compact ASCII table in plain text. Do NOT use Markdown tables for findings.

Use this exact column layout:

\`\`\`text
+----+----------+-------------------------------+------------------------------------------+
| ID | Severity | Location                      | Summary                                  |
+----+----------+-------------------------------+------------------------------------------+
| F1 | medium   | src/path/file.ts:42-57       | Short bug title                          |
+----+----------+-------------------------------+------------------------------------------+
\`\`\`

Rules:

- Keep the full table within roughly 100 characters wide.
- One bug per row.
- \`ID\` must be \`F1\`, \`F2\`, \`F3\`, ...
- \`Severity\` must be one of: \`critical\`, \`high\`, \`medium\`.
- \`Location\` must be a repo-relative path plus line reference like \`src/x.ts:42-57\`.
- \`Summary\` must be short and scannable. Put the full explanation in the detail section, not in the table.

If you found no solid bugs, write \`No confirmed bugs found.\`

### Finding details

After the ASCII summary table, add one detail block per finding in this format:

\`\`\`text
[F1] Short bug title
Severity: medium
Location: src/path/file.ts:42-57
Why it breaks: ...
Reproduction hint: ...
\`\`\`

Rules:

- \`Why it breaks\` must state the actual failure mode or technical risk.
- \`Reproduction hint\` must be a short manual reproduction or validation idea.
- Do not hide critical detail inside the summary table.

### Coverage

List 3-6 bullets describing which files, flows, or seams you inspected first and what strategy/style led you there.

### Next step offer

- If there is at least one \`critical\` or \`medium\` finding, end with exactly this question:

\`Do you want me to create dev3 tasks for the critical and medium findings, one task per finding?\`

- Otherwise, end with exactly this sentence:

\`I can write reproduction tests for the strongest finding if you want a validation pass.\`

## If the user approves dev3 task creation

Create one dev3 task per \`critical\` or \`medium\` finding. Do not batch multiple bugs into one task.

Each task must:

- Use a concise title that names the bug.
- Start the description with the bug summary, location, severity, failure mode, and the evidence you found.
- State clearly that the first step is validation, not fixing.
- Require this execution order:
  1. Validate whether the bug is real.
  2. Reproduce it with a failing test or another reliable repro.
  3. Fix it only after the reproduction is proven.
  4. Re-run the repro to confirm the fix.

The task description must explicitly say:

- If the bug cannot be reproduced, stop and do not attempt a fix.
- Report back to the user with this exact sentence:

\`\`\`text
I could not reproduce this bug, so I did not attempt a fix. Please verify it manually; the issue may be invalid.
\`\`\`

When you create these follow-up tasks in dev3, include enough detail that a separate agent can execute them without re-reading the original bug-hunt report.
`;

const BUG_HUNTER_OPENAI_YAML = `interface:
  display_name: "dev3 Bug Hunter"
  short_description: "Run a seeded bug hunt tuned for parallel dev3 variants"
  default_prompt: "Use $dev3-bug-hunter to run a read-only bug hunt with a seeded exploration strategy in this codebase."
`;

export function getProjectConfigSkillContent(): string {
	return PROJECT_CONFIG_SKILL_BODY;
}

export function getBugHunterSkillContent(): string {
	return BUG_HUNTER_SKILL_CONTENT;
}

export function getClaudeSkillContent(): string {
	return CLAUDE_SKILL_CONTENT;
}

export function getCodexSkillContent(): string {
	return CODEX_SKILL_CONTENT;
}

export function getGenericSkillContent(): string {
	return GENERIC_SKILL_CONTENT;
}

/** Claude Code project-config skill directory. */
const CLAUDE_PROJECT_CONFIG_DIR = ".claude/skills/dev3-project-config";

/** Generic agent project-config skill directories. */
const GENERIC_PROJECT_CONFIG_DIRS = [
	".cursor/skills/dev3-project-config",
	".agents/skills/dev3-project-config",
	".codex/skills/dev3-project-config",
	".opencode/skills/dev3-project-config",
	".config/opencode/skills/dev3-project-config",
];

const BUG_HUNTER_SKILL_DIRS = [
	".claude/skills/dev3-bug-hunter",
	".cursor/skills/dev3-bug-hunter",
	".agents/skills/dev3-bug-hunter",
	".codex/skills/dev3-bug-hunter",
	".opencode/skills/dev3-bug-hunter",
	".config/opencode/skills/dev3-bug-hunter",
];

const SHARED_SKILL_OPENAI_CONFIGS = [
	{
		dir: ".agents/skills/dev3",
		content: DEV3_OPENAI_YAML,
	},
	{
		dir: ".agents/skills/dev3-project-config",
		content: PROJECT_CONFIG_OPENAI_YAML,
	},
	{
		dir: ".agents/skills/dev3-bug-hunter",
		content: BUG_HUNTER_OPENAI_YAML,
	},
];

const LEGACY_GEMINI_SKILL_DUPLICATES = [
	{
		agentsSkillFile: ".agents/skills/dev3/SKILL.md",
		geminiSkillDir: ".gemini/skills/dev3",
	},
	{
		agentsSkillFile: ".agents/skills/dev3-project-config/SKILL.md",
		geminiSkillDir: ".gemini/skills/dev3-project-config",
	},
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

function cleanupLegacyGeminiSkillDuplicates(home: string): void {
	for (const entry of LEGACY_GEMINI_SKILL_DUPLICATES) {
		const agentsSkillFile = `${home}/${entry.agentsSkillFile}`;
		const geminiSkillDir = `${home}/${entry.geminiSkillDir}`;

		if (!existsSync(agentsSkillFile) || !existsSync(geminiSkillDir)) {
			continue;
		}

		try {
			rmSync(geminiSkillDir, { recursive: true, force: true });
			log.info("Removed legacy Gemini skill duplicate", {
				path: geminiSkillDir,
				replacedBy: agentsSkillFile,
			});
		} catch (err) {
			log.warn("Failed to remove legacy Gemini skill duplicate (non-fatal)", {
				path: geminiSkillDir,
				error: String(err),
			});
		}
	}
}

function installOpenAiMetadata(home: string): void {
	for (const entry of SHARED_SKILL_OPENAI_CONFIGS) {
		const metadataDir = `${home}/${entry.dir}/agents`;
		const metadataFile = `${metadataDir}/openai.yaml`;

		try {
			mkdirSync(metadataDir, { recursive: true });
			writeFileSync(metadataFile, entry.content, "utf-8");
			log.info("Managed skill metadata installed", { path: metadataFile });
		} catch (err) {
			log.warn("Failed to install managed skill metadata (non-fatal)", {
				path: metadataFile,
				error: String(err),
			});
		}
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

	for (const dir of BUG_HUNTER_SKILL_DIRS) {
		const skillDir = `${home}/${dir}`;
		const skillFile = `${skillDir}/SKILL.md`;
		try {
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(skillFile, BUG_HUNTER_SKILL_CONTENT, "utf-8");
			log.info("Bug Hunter skill installed", { path: skillFile });
		} catch (err) {
			log.warn("Failed to install Bug Hunter skill (non-fatal)", {
				path: skillFile,
				error: String(err),
			});
		}
	}

	cleanupLegacyGeminiSkillDuplicates(home);
	installOpenAiMetadata(home);
	installAgentsMd();
	ensureClaudePermission();
	ensureCodexConfigFile(home);
}
