import { describe, expect, it, vi } from "vitest";
import {
	applyClaudeSettings,
	buildClaudeSkillContent,
	buildCodexSkillContent,
	buildGenericSkillContent,
	claudeBashPermission,
	CLAUDE_SKILL_BODY,
	getAskDev3SkillContent,
	getBugHunterSkillContent,
	getClaudeSkillContent,
	getCodexSkillContent,
	getGenericSkillContent,
	getProjectConfigSkillContent,
	getTmuxSkillContent,
	getShareArtifactSkillContent,
	getTmuxSkillDescription,
	MANAGED_SKILL_FILES,
} from "../agent-skills";
import {
	CLI_EXIT_CODE_ARTIFACT_ASSET_MISSING,
	CLI_EXIT_CODE_ARTIFACT_SECRET_FOUND,
} from "../../shared/cli-exit-codes";
import { ARTIFACT_TEMPLATE_FILES } from "../../shared/artifact-template";
import { AGENT_MESSAGE_SUBMIT_IDLE_SECONDS } from "../../shared/agent-message-coalescing";
import { skillPrLinkInstruction } from "../../shared/agent-skill-content";
import { hookCliDialect } from "../../shared/dev3-cli-path";

// The Claude SKILL.md is deliberately short (the protocol lives in the system
// prompt via --append-system-prompt), so body-content assertions run against
// CLAUDE_SKILL_BODY — the text Claude actually receives.

describe("platform feedback skill section (always present)", () => {
	it("teaches every agent the private vent and opt-in public issue workflows", () => {
		for (const skill of [CLAUDE_SKILL_BODY, getCodexSkillContent(), getGenericSkillContent()]) {
			expect(skill).toContain("## Platform feedback — vents");
			expect(skill).toContain('dev3 vents "short name" "markdown body"');
			expect(skill).toContain("Anonymity is mandatory");
			expect(skill).toContain("would the dev3 maintainer have to change or extend dev3 to address this?");
			expect(skill).toContain("Something is missing that would help");
			expect(skill).toContain("at most once per user message");
			expect(skill).toContain("### Offer to file a public bug report");
			expect(skill).toContain("send the private vent first (silently, as always)");
			expect(skill).toContain("Never mention the private vent");
			expect(skill).toContain("this offer is the first they hear of it");
			expect(skill).toContain("an explicit yes/no ask");
			expect(skill).toContain("using your GitHub");
			expect(skill).toContain("--repo h0x91b/dev-3.0");
			expect(skill).toContain('--label "Reported by AI"');
			expect(skill).toContain("still never reference the vent");
			expect(skill.indexOf('dev3 vents "short name" "markdown body"')).toBeLessThan(
				skill.indexOf("### Offer to file a public bug report"),
			);
		}
	});
});

describe("dev3 skill content", () => {
	it("exempts in-task bug hunters from mutating the originating task", () => {
		for (const skill of [CLAUDE_SKILL_BODY, getCodexSkillContent(), getGenericSkillContent()]) {
			expect(skill).toContain("## In-task Bug Hunter isolation");
			expect(skill).toContain("This exception overrides the session-start checklist");
			expect(skill).toContain(
				"Do NOT change the existing task's title, description, overview, labels, priority, status, assigned agent, or configuration.",
			);
			expect(skill).toContain(
				"The only allowed write to the existing task is `dev3 note add`",
			);
			expect(skill.indexOf("## In-task Bug Hunter isolation")).toBeLessThan(
				skill.indexOf("## Session-start checklist"),
			);
		}
	});

	it("blocks nested worktrees other skills ask for", () => {
		for (const skill of [CLAUDE_SKILL_BODY, getCodexSkillContent(), getGenericSkillContent()]) {
			expect(skill).toContain("This worktree already IS your isolation.");
			expect(skill).toContain("`git worktree add`");
			expect(skill).toContain("even when another skill, workflow, or agent tool asks for one");
			expect(skill).toContain("Only an explicit request from the user overrides this.");
		}
	});

	it("routes unqualified artifacts to the task-local dev3 starter", () => {
		for (const skill of [CLAUDE_SKILL_BODY, getCodexSkillContent(), getGenericSkillContent()]) {
			expect(skill).toContain("## dev3 HTML artifacts");
			expect(skill).toContain("DEV3_ARTIFACT_TEMPLATE_DIR");
			expect(skill).toContain('cp -R "$DEV3_ARTIFACT_TEMPLATE_DIR" ./dev3-artifact-report');
			expect(skill).toContain("The layout is fixed; do not spend a turn listing or rediscovering it");
			for (const file of ARTIFACT_TEMPLATE_FILES) {
				expect(skill).toContain(`\`${file}\``);
			}
			expect(skill).toContain("Do not read the shell files for ordinary reports");
			expect(skill).toContain("Claude Artifacts");
			expect(skill).toContain(
				'dev3 show-artifact ./dev3-artifact-report/index.html --assets ./dev3-artifact-report/app.css ./dev3-artifact-report/report.js ./dev3-artifact-report/app.js ./dev3-artifact-report/dev3-icon.png --title "Report title"',
			);
			expect(skill).not.toContain("--images");
		}
	});

	it("folds label guidance into the session-start title pass", () => {
		const codexSkill = getCodexSkillContent();
		expect(codexSkill).toContain(
			"Aim for **1-2 meaningful labels per task** in the normal case",
		);
		expect(codexSkill).toContain("In the same session-start pass, also assign task labels:");
		expect(codexSkill).toContain("dev3 label list");
		expect(codexSkill).toContain('dev3 label create "name"');
		expect(codexSkill).toContain("dev3 label set <id> [<id>...]");
		expect(codexSkill).toContain("Creating a label without attaching it does **not** complete this step.");
		expect(codexSkill).not.toContain("## Task labels");
		expect(codexSkill.indexOf("## Title generation")).toBeLessThan(
			codexSkill.indexOf("dev3 label list"),
		);
	});

	it("front-loads a session-start checklist with an event-anchored hard gate", () => {
		for (const skill of [CLAUDE_SKILL_BODY, getCodexSkillContent(), getGenericSkillContent()]) {
			expect(skill).toContain("## Session-start checklist");
			// Event-anchored gate, not "session start" which agents race past
			expect(skill).toContain("finish this checklist before you end your first turn");
			// Title step explicitly covers the scratch placeholder, the case that fell through
			expect(skill).toContain("replace a scratch placeholder");
			// Checklist precedes the detailed sections it points at
			expect(skill.indexOf("## Session-start checklist")).toBeLessThan(skill.indexOf("## Branch naming"));
			expect(skill.indexOf("## Session-start checklist")).toBeLessThan(skill.indexOf("## Title generation"));
		}
	});

	it("couples title-setting to the initial-overview moment", () => {
		for (const skill of [CLAUDE_SKILL_BODY, getCodexSkillContent(), getGenericSkillContent()]) {
			expect(skill).toContain("same pass as the title and labels");
		}
	});

	it("keeps embedded label guidance consistent across agent variants", () => {
		expect(CLAUDE_SKILL_BODY).toContain("In the same session-start pass, also assign task labels:");
		expect(getGenericSkillContent()).toContain("In the same session-start pass, also assign task labels:");
		expect(CLAUDE_SKILL_BODY).toContain("reuse existing labels whenever possible.");
		expect(getGenericSkillContent()).toContain("reuse existing labels whenever possible.");
		expect(CLAUDE_SKILL_BODY).toContain("attach it to the current task immediately.");
		expect(getGenericSkillContent()).toContain("attach it to the current task immediately.");
	});

	it("gates completion on preserved work or an explicit user request", () => {
		for (const skill of [CLAUDE_SKILL_BODY, getCodexSkillContent(), getGenericSkillContent()]) {
			expect(skill).toContain("Never move a task to `completed`, and never request completion approval");
			expect(skill).toContain("safely preserved in the destination the task requires");
			expect(skill).toContain("commonly a pull request merged into `main`");
			expect(skill).toContain("external file, task note, shared artifact");
			expect(skill).toContain("the user explicitly asks to complete the task");
			expect(skill).toContain("A local commit, passing tests, or an open/unmerged pull request is not enough by itself");
			expect(skill).toContain("If the required destination is unclear or the work is not safely preserved");
		}
	});

	it("adds conservative dev-server control guidance across agent variants", () => {
		expect(getCodexSkillContent()).toContain("## Dev Server Control");
		expect(getCodexSkillContent()).toContain("`dev3 dev-server status` is low-risk");
		expect(getCodexSkillContent()).toContain("Do not use them by default.");
		expect(CLAUDE_SKILL_BODY).toContain("Before doing so, briefly tell the user what you are about to do.");
		expect(getGenericSkillContent()).toContain("If you started the dev server only for verification, stop it afterwards");
	});

	it("documents mutually exclusive notify duration and desktop forms", () => {
		for (const skill of [CLAUDE_SKILL_BODY, getCodexSkillContent(), getGenericSkillContent()]) {
			expect(skill).toContain(
				'`dev3 notify "message" [--level info|success|error] [--duration <seconds>]` — clickable in-app toast',
			);
			expect(skill).toContain(
				'`dev3 notify "message" [--level info|success|error] --desktop` — sends a native OS notification',
			);
			expect(skill).toContain("`--duration` applies only to in-app toasts.");
			expect(skill).toContain("do not combine `--desktop` with `--duration`.");

			const notifyExamples = skill.split("\n").filter((line) => line.startsWith("- `dev3 notify"));
			const notifyCommands = notifyExamples.map((line) => line.match(/^- `([^`]+)`/)?.[1] ?? "");
			expect(notifyCommands.every((command) => !(command.includes("--duration") && command.includes("--desktop")))).toBe(true);
		}
	});

	it("teaches the backend-neutral pane commands, so a Windows agent is not sent to a binary it has no chance of finding", () => {
		for (const skill of [CLAUDE_SKILL_BODY, getCodexSkillContent(), getGenericSkillContent()]) {
			expect(skill).toContain("## Panes — run long commands next to yourself");
			expect(skill).toContain("dev3 pane list");
			expect(skill).toContain("dev3 pane run");
			expect(skill).toContain("dev3 pane logs");
			expect(skill).toContain("dev3 pane close");
			// The outcome distinction the whole feature exists for.
			expect(skill).toContain("still running");
			expect(skill).toContain("exit code N");
			// Short version still points to the full tmux reference for tmux-only work.
			expect(skill).toContain("/dev3-tmux");
		}
	});

	/**
	 * THE guard this task exists for: on a native-backend task every tmux sentence
	 * in the old skill was false, and an agent that believes a false statement about
	 * its own environment burns turns proving the obvious. A tmux mention is allowed
	 * — as a CONDITION, never as a fact about where the agent is.
	 */
	it("never states tmux as a fact about the agent's own environment", () => {
		const forbidden: Array<[RegExp, string]> = [
			[/(?:You|you) are running\s+\*{0,2}inside a tmux session/, "asserts the agent is inside a tmux session"],
			[/Always use `-L dev3`/, "orders every command onto a tmux socket"],
			[/^[^\n]*\btmux -L dev3\b/m, "hands out a raw tmux command as if tmux existed"],
			[/socket `dev3`, session name/, "states a tmux session name as the agent's own"],
		];
		for (const skill of [CLAUDE_SKILL_BODY, getCodexSkillContent(), getGenericSkillContent()]) {
			for (const [pattern, why] of forbidden) {
				expect(pattern.test(skill), `injected skill ${why}: ${pattern}`).toBe(false);
			}
		}
	});

	it("keeps the main /dev3 pane summary short (does not duplicate the full tmux reference)", () => {
		// The detailed command reference must live in the separate /dev3-tmux skill,
		// not be duplicated inline in the main skill body.
		for (const skill of [CLAUDE_SKILL_BODY, getCodexSkillContent(), getGenericSkillContent()]) {
			expect(skill).not.toContain("Open a pane or window and run a command");
			expect(skill).not.toContain("Resize a pane — absolute width / height");
			expect(skill).not.toContain("Re-tile all panes in the window");
		}
	});

	// A retune of the coalescing window used to leave hand-written "ten seconds"
	// behind in this text, so every agent on the board was told a number the code
	// no longer honoured — and then peeked at or chased a peer that was still
	// inside the real window. The prose now interpolates the constant; this asserts
	// the interpolation actually reaches the rendered text.
	it("quotes the live coalescing window instead of a hand-written number", () => {
		const seconds = AGENT_MESSAGE_SUBMIT_IDLE_SECONDS;
		for (const skill of [CLAUDE_SKILL_BODY, getCodexSkillContent(), getGenericSkillContent(), getAskDev3SkillContent()]) {
			expect(skill).toContain(`~${seconds}s of quiet`);
			expect(skill).toMatch(new RegExp(`about ${seconds} seconds|takes about ${seconds} seconds`));
			// No stale spelled-out number left next to the live one.
			expect(skill).not.toContain("about ten seconds");
			expect(skill).not.toContain("~10s of quiet");
		}
	});
});

describe("Claude SKILL.md (short variant — protocol lives in the system prompt)", () => {
	it("does not duplicate the protocol body that --append-system-prompt already injects", () => {
		const skill = getClaudeSkillContent();
		expect(skill).not.toContain("## Session-start checklist");
		expect(skill).not.toContain("## Platform feedback — vents");
		expect(skill).not.toContain("## Getting the user's attention");
	});

	it("points sessions started outside the launcher at the PROTOCOL.md fallback", () => {
		expect(getClaudeSkillContent()).toContain("PROTOCOL.md");
	});

	it("keeps the zero-tool-call status auto-set and the brief task snapshot", () => {
		const skill = getClaudeSkillContent();
		expect(skill).toContain("task move --status in-progress --if-status-not review-by-ai");
		expect(skill).toContain("dev3 current --brief");
		// The full `dev3 current` would re-print the description Claude already
		// holds as its initial prompt.
		expect(skill).not.toContain("dev3 current`\n");
	});

	it("codex and generic skill files keep the full body (their only reliable channel)", () => {
		// Codex scratch tasks and Gemini/Cursor/OpenCode sessions get no
		// system-prompt injection — SKILL.md is load-bearing for them.
		expect(getCodexSkillContent()).toContain("## Session-start checklist");
		expect(getGenericSkillContent()).toContain("## Session-start checklist");
	});

	it("keeps normal Codex lifecycle transitions exclusively hook-owned", () => {
		const codexSkill = getCodexSkillContent();

		expect(codexSkill).toContain("Never call `dev3 task move` for normal lifecycle transitions");
		expect(codexSkill).toContain("semantic question that no native event can detect");
		expect(codexSkill).not.toContain("task move --status in-progress");
		expect(codexSkill).not.toContain("fall back to manual status management");
		expect(codexSkill).not.toContain("set `in-progress` manually");
		expect(codexSkill).not.toContain("move to `review-by-user` when finished");

		// Agents without native hooks still need the manual protocol.
		expect(getGenericSkillContent()).toContain("task move --status in-progress");
	});
});

describe("dev3-tmux skill content", () => {
	/**
	 * The reference itself is fine; loading it on a task that has no tmux is not.
	 * The gate has to be the FIRST thing the agent reads, before any command it
	 * could try, and it has to name the check rather than the platform.
	 */
	it("gates itself on the backend before handing out a single tmux command", () => {
		const skill = getTmuxSkillContent();
		const gate = skill.indexOf("## Check this first — tmux is not a given");
		const firstTmuxCommand = skill.indexOf("tmux -L dev3");
		expect(gate).toBeGreaterThanOrEqual(0);
		expect(gate).toBeLessThan(firstTmuxCommand);
		expect(skill).toContain("dev3 pane list");
		expect(skill).toContain("Everything below applies only if that says `tmux`");
		// Never "you are on Windows, so…": the native backend is not Windows-only.
		expect(skill).toContain("Do not infer the backend from the platform");
		// And it must send the agent to the surface that works everywhere.
		expect(skill).toContain("dev3 pane run");
		expect(skill).toContain("dev3 pane logs");
	});

	it("declares itself tmux-only in the description an agent decides from", () => {
		const description = getTmuxSkillDescription();
		expect(description).toMatch(/TMUX-backed task only/i);
		expect(description).toContain("dev3 pane list");
		expect(description).toContain("dev3 pane run");
	});

	it("contains the full tmux command reference", () => {
		const skill = getTmuxSkillContent();
		expect(skill).toContain("# dev3-tmux — Full tmux reference");
		expect(skill).toContain("## 1. Session layout");
		expect(skill).toContain("## 2. Discovery");
		expect(skill).toContain("## 3. When to use a tmux pane vs inline Bash");
		expect(skill).toContain("## 4. Open a pane or window and run a command");
		expect(skill).toContain("## 5. Organize windows and panes");
		expect(skill).toContain("## 6. Read what is happening in a pane");
		expect(skill).toContain("## 7. Common pitfalls");
		expect(skill).toContain("tmux -L dev3 split-window -h");
		expect(skill).toContain("tmux -L dev3 split-window -v");
		expect(skill).toContain("tmux -L dev3 new-window");
		expect(skill).toContain("tmux -L dev3 send-keys");
		expect(skill).toContain("tmux -L dev3 swap-window");
		expect(skill).toContain("tmux -L dev3 move-window");
		expect(skill).toContain("tmux -L dev3 resize-pane");
		expect(skill).toContain("tmux -L dev3 capture-pane");
		expect(skill).toContain("tmux -L dev3 kill-pane");
	});

	it("warns about the most common pitfalls", () => {
		const skill = getTmuxSkillContent();
		expect(skill).toContain("Forgetting `-L dev3`");
		expect(skill).toContain("Forgetting `Enter` in `send-keys`");
		expect(skill).toContain("Caching pane ids");
		expect(skill).toContain("Running the canonical dev server in an ad-hoc pane");
		expect(skill).toContain("Opening a new-window for a background process");
	});

	it("makes split-window the explicit default and restricts new-window to explicit user request", () => {
		// Background-process bug: agent kept opening a new tmux tab for celery
		// workers / docker exec instead of splitting a pane next to itself.
		// The skill must be unambiguous about the default.
		const skill = getTmuxSkillContent();
		expect(skill).toContain("Default: split-window (pane). Use new-window only when the user explicitly asks for a tab.");
		expect(skill).toMatch(/always.*split-window.*never.*new-window/i);
	});

	it("tells the agent to give windows human names instead of the auto command-name", () => {
		const skill = getTmuxSkillContent();
		expect(skill).toContain("**Always name a window you open**");
		expect(skill).toMatch(/turns off automatic-rename/i);
	});

	it("tells the agent to proactively rename generic windows it did not open", () => {
		const skill = getTmuxSkillContent();
		expect(skill).toContain("**Also tidy windows you did not open.**");
		expect(skill).toMatch(/list-windows/);
		expect(skill).toMatch(/proactively/i);
	});
});

describe("dev3-project-config skill content", () => {
	it("requires repo-specific evidence for each port mapping", () => {
		expect(getProjectConfigSkillContent()).toContain(
			"For every mapping, record the exact evidence from this repo",
		);
	});

	it("keeps port discovery guidance tool-agnostic", () => {
		expect(getProjectConfigSkillContent()).toContain(
			"Inspect the codebase and dev/runtime configuration to estimate how many concurrent ports the dev stack needs",
		);
		expect(getProjectConfigSkillContent()).toContain(
			"Check app start commands and dev scripts for port references",
		);
		expect(getProjectConfigSkillContent()).not.toContain(
			"Look at `package.json` scripts and `docker-compose.yml` to estimate",
		);
	});

	it("forbids inferring env vars from the framework name alone", () => {
		expect(getProjectConfigSkillContent()).toContain(
			"Do NOT infer env vars from the framework name alone.",
		);
	});

	it("does not include the generic framework env var table", () => {
		expect(getProjectConfigSkillContent()).not.toContain(
			"Common frameworks & their port env vars",
		);
	});

	it("requires disabling portCount when no explicit override exists", () => {
		expect(getProjectConfigSkillContent()).toContain(
			"If you cannot find an explicit port override mechanism in this project, do NOT guess with a generic `PORT=` assignment. Set `portCount: 0` and explain why.",
		);
	});

	it("requires a smoke test when ports are mapped", () => {
		expect(getProjectConfigSkillContent()).toContain(
			"If `portCount > 0`, also smoke-test the mapping:",
		);
	});

	it("documents project environment variables and their secret-storage boundary", () => {
		const skill = getProjectConfigSkillContent();
		expect(skill).toContain("| `env` | Record<string, string> |");
		expect(skill).toContain("This field is not for secrets; `.dev3/config.json` is committed.");
	});
});

describe("dev3 Bug Hunter skill content", () => {
	it("keeps the seeded initialization sequence intact", () => {
		const skill = getBugHunterSkillContent();

		expect(skill).toContain("name: dev3-bug-hunter");
		expect(skill).toContain("echo $(od -An -N2 -tu2 /dev/urandom | tr -d ' ')");
		expect(skill).toContain("letter_index = seed % 26");
		expect(skill).toContain("strategy = seed % 6");
		expect(skill).toContain("style = floor(seed / 6) % 4");
		expect(skill).toContain("Agent [LETTER] | Strategy: [name] | Style: [name] | Seed: [number]");
	});

	it("forces bug hunts to start from the assigned strategy area", () => {
		const skill = getBugHunterSkillContent();

		expect(skill).toContain("You MUST begin from your assigned area.");
		expect(skill).toContain("Do not jump to other areas until you have examined yours thoroughly.");
		expect(skill).toContain("Logic errors and off-by-one mistakes");
		expect(skill).toContain("Silent failures and swallowed errors");
	});

	it("stays read-only and requires a uniform findings format", () => {
		const skill = getBugHunterSkillContent();

		expect(skill).toContain("This skill is review-only.");
		expect(skill).toContain("Do NOT modify code, apply patches, create commits, or rewrite files.");
		expect(skill).toContain("Do NOT run the dev3 session-start checklist");
		expect(skill).toContain(
			"Do NOT change the existing task's title, description, overview, labels, priority, status, assigned agent, or configuration.",
		);
		expect(skill).toContain("The only allowed write to the existing task is `dev3 note add`");
		expect(skill).toContain(
			"You MAY create dev3 tasks only after the user explicitly approves task creation for findings.",
		);
		expect(skill).toContain("Use a compact ASCII table in plain text. Do NOT use Markdown tables for findings.");
		expect(skill).toContain("| ID | Severity | Location                      | Summary");
		expect(skill).toContain("Keep the full table within roughly 100 characters wide.");
		expect(skill).toContain("ID` must be `F1`, `F2`, `F3`, ...");
		expect(skill).toContain("Severity` must be one of: `critical`, `high`, `medium`");
		expect(skill).toContain("### Finding details");
		expect(skill).toContain("[F1] Short bug title");
		expect(skill).toContain("Do not hide critical detail inside the summary table.");
		expect(skill).toContain(
			"Do you want me to create dev3 tasks for the critical and medium findings, one task per finding?",
		);
		expect(skill).toContain(
			"I can write reproduction tests for the strongest finding if you want a validation pass.",
		);
		expect(skill).toContain("Create one dev3 task per `critical` or `medium` finding.");
		expect(skill).toContain("Validate whether the bug is real.");
		expect(skill).toContain("Reproduce it with a failing test or another reliable repro.");
		expect(skill).toContain(
			"I could not reproduce this bug, so I did not attempt a fix. Please verify it manually; the issue may be invalid.",
		);
	});

	it("documents the in-task note reporting channel", () => {
		const skill = getBugHunterSkillContent();

		expect(skill).toContain("## Task mode: record findings as dev3 notes");
		// The main agent, not the pane, is the real consumer in task mode.
		expect(skill).toContain(
			"the **main agent that will actually fix the bugs never sees it**",
		);
		// One note per finding, marker-prefixed, via the dev3 note CLI.
		expect(skill).toContain('dev3 note add "[bug-hunt] <severity> <path:lines>');
		expect(skill).toContain("one note per finding, never batched");
		expect(skill).toContain("The literal `[bug-hunt]` marker at the very start is mandatory");
		// Note mode suppresses the standalone task-creation offer.
		expect(skill).toContain(
			'do NOT emit the "Next step offer" question and do NOT create dev3 tasks yourself',
		);
	});
});

describe("applyClaudeSettings (Claude Code sandbox socket allowlist, issue #726)", () => {
	const SOCKETS = "/Users/testuser/.dev3.0/sockets";

	it("adds the dev3 CLI permission and the sockets dir to a fresh settings object", () => {
		const settings: Record<string, unknown> = {};
		const changed = applyClaudeSettings(settings, SOCKETS);

		expect(changed).toBe(true);
		const permissions = settings.permissions as { allow: string[] };
		expect(permissions.allow).toContain("Bash(~/.dev3.0/bin/dev3 *)");
		const sandbox = settings.sandbox as { network: { allowUnixSockets: string[] } };
		expect(sandbox.network.allowUnixSockets).toEqual([SOCKETS]);
	});

	it("allow-lists the sockets DIRECTORY, not a *.sock glob", () => {
		const settings: Record<string, unknown> = {};
		applyClaudeSettings(settings, SOCKETS);
		const sandbox = settings.sandbox as { network: { allowUnixSockets: string[] } };
		expect(sandbox.network.allowUnixSockets[0]).toBe(SOCKETS);
		expect(sandbox.network.allowUnixSockets[0]).not.toContain("*");
	});

	it("is a no-op (returns false) when both entries are already present", () => {
		const settings: Record<string, unknown> = {
			permissions: { allow: ["Bash(~/.dev3.0/bin/dev3 *)"] },
			sandbox: { network: { allowUnixSockets: [SOCKETS] } },
		};
		expect(applyClaudeSettings(settings, SOCKETS)).toBe(false);
	});

	it("preserves unrelated settings and existing allow/socket entries", () => {
		const settings: Record<string, unknown> = {
			model: "claude-opus-4-8",
			permissions: { allow: ["Bash(ls *)"], deny: ["Bash(rm *)"] },
			sandbox: { network: { allowUnixSockets: ["/tmp/other.sock"] } },
		};
		const changed = applyClaudeSettings(settings, SOCKETS);

		expect(changed).toBe(true);
		expect(settings.model).toBe("claude-opus-4-8");
		const permissions = settings.permissions as { allow: string[]; deny: string[] };
		expect(permissions.allow).toEqual(["Bash(ls *)", "Bash(~/.dev3.0/bin/dev3 *)"]);
		expect(permissions.deny).toEqual(["Bash(rm *)"]);
		const sandbox = settings.sandbox as { network: { allowUnixSockets: string[] } };
		expect(sandbox.network.allowUnixSockets).toEqual(["/tmp/other.sock", SOCKETS]);
	});

	it("does not duplicate the socket when only the permission is missing", () => {
		const settings: Record<string, unknown> = {
			sandbox: { network: { allowUnixSockets: [SOCKETS] } },
		};
		const changed = applyClaudeSettings(settings, SOCKETS);
		expect(changed).toBe(true); // permission was added
		const sandbox = settings.sandbox as { network: { allowUnixSockets: string[] } };
		expect(sandbox.network.allowUnixSockets).toEqual([SOCKETS]);
	});
});

describe("skill content per platform dialect", () => {
	const WINDOWS = hookCliDialect({
		platform: "win32",
		execDir: "C:\\dev3",
		homeDir: "C:\\Users\\dev",
		exists: () => false,
	});
	const POSIX = hookCliDialect({ platform: "darwin" });

	it("keeps the POSIX skill text byte-identical to this machine's output", () => {
		expect(buildClaudeSkillContent(POSIX)).toBe(getClaudeSkillContent());
		expect(buildCodexSkillContent(POSIX)).toBe(getCodexSkillContent());
		expect(buildGenericSkillContent(POSIX)).toBe(getGenericSkillContent());
		expect(buildClaudeSkillContent(POSIX)).toContain("~/.dev3.0/bin/dev3 current --brief");
	});

	it("gives Windows an absolute dev3.exe with no stderr redirect", () => {
		const cli = '"C:/Users/dev/.dev3.0/bin/dev3.exe"';

		const claude = buildClaudeSkillContent(WINDOWS);
		expect(claude).toContain(`!\`${cli} task move --status in-progress --if-status-not review-by-ai\``);
		expect(claude).toContain(`!\`${cli} current --brief\``);
		// Windows has no POSIX shell in the injection runner.
		expect(claude).not.toContain("2>&1");
		expect(claude).not.toContain("~/.dev3.0/bin/dev3");

		// The shared protocol body is dialect-neutral prose; only the generated
		// session-start block is templated, so assert on that.
		for (const content of [buildCodexSkillContent(WINDOWS), buildGenericSkillContent(WINDOWS)]) {
			expect(content).toContain(`- \`${cli} --help\` — learn all available CLI commands`);
			expect(content).toContain(`- \`${cli} current\` — see your current project, task, and status`);
		}
	});

	it("spells the Claude bash permission the same way the generated commands do", () => {
		expect(claudeBashPermission(POSIX)).toBe("Bash(~/.dev3.0/bin/dev3 *)");
		expect(claudeBashPermission(WINDOWS)).toBe('Bash("C:/Users/dev/.dev3.0/bin/dev3.exe" *)');
	});
});

// The origin-task PR footer is only useful where the OS resolves `dev3://`. On
// every other platform the injected skill must not order the agent to publish a
// dead link into a public pull request.
describe("PR origin-task footer — gated on a real dev3:// handler", () => {
	it("hands macOS the footer, verbatim", () => {
		const text = skillPrLinkInstruction("darwin");
		expect(text).toContain("**Link the PR back to this task.**");
		expect(text).toContain("https://dev3.h0x91b.com/open.html?task=<TASK_ID>");
		expect(text).toContain("dev3://task/<TASK_ID>");
	});

	for (const platform of ["win32", "linux"] as NodeJS.Platform[]) {
		it(`refuses the footer on ${platform} and hands out no link at all`, () => {
			const text = skillPrLinkInstruction(platform);
			expect(text).toContain("Do NOT append a dev3 origin-task footer");
			expect(text).not.toContain("open.html");
			expect(text).not.toContain("dev3://task/");
			expect(text).not.toContain("Origin task in dev3");
		});
	}

	it("composes the platform's own variant into every injected body", async () => {
		const original = process.platform;
		try {
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			vi.resetModules();
			const win = await import("../../shared/agent-skill-content");
			for (const body of [win.CLAUDE_SKILL_BODY, win.CODEX_SKILL_BODY, win.GENERIC_SKILL_BODY]) {
				expect(body).toContain("Do NOT append a dev3 origin-task footer");
				expect(body).not.toContain("Origin task in dev3");
				expect(body).not.toContain("open.html");
			}

			Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
			vi.resetModules();
			const mac = await import("../../shared/agent-skill-content");
			for (const body of [mac.CLAUDE_SKILL_BODY, mac.CODEX_SKILL_BODY, mac.GENERIC_SKILL_BODY]) {
				expect(body).toContain("🔗 **Origin task in dev3:**");
				expect(body).not.toContain("Do NOT append a dev3 origin-task footer");
			}
		} finally {
			Object.defineProperty(process, "platform", { value: original, configurable: true });
			vi.resetModules();
		}
	});
});

describe("dev3-share-artifact skill content", () => {
	it("is named with the correct spelling and is user-invocable", () => {
		const skill = getShareArtifactSkillContent();

		expect(skill).toContain("name: dev3-share-artifact");
		expect(skill).toContain("user-invocable: true");
		expect(skill).not.toContain("artefact");
	});

	it("drives publishing through the dev3 inliner rather than an external script", () => {
		const skill = getShareArtifactSkillContent();

		expect(skill).toContain("dev3 inline-html <artifact-dir-or-index.html> -o /tmp/<name>.html");
		expect(skill).not.toContain("inline_html.py");
		expect(skill).not.toContain("python3");
	});

	it("documents the two refusals with the CLI's own exit codes", () => {
		const skill = getShareArtifactSkillContent();

		expect(skill).toContain(`| \`${CLI_EXIT_CODE_ARTIFACT_ASSET_MISSING}\` | A referenced local file is missing`);
		expect(skill).toContain(`| \`${CLI_EXIT_CODE_ARTIFACT_SECRET_FOUND}\` | A credential-shaped string is embedded`);
	});

	it("checks .gist-id before deciding create-vs-update, and defaults to secret", () => {
		const skill = getShareArtifactSkillContent();

		expect(skill).toContain("cat <artifact-dir>/.gist-id 2>/dev/null");
		expect(skill).toContain("**Default to secret.**");
		expect(skill).toContain("an existing gist should be updated, not\nduplicated");
	});

	it("carries no machine-specific account mapping — it ships to every user", () => {
		const skill = getShareArtifactSkillContent();

		expect(skill).not.toContain("h0x91b");
		expect(skill).not.toContain("/Users/");
		expect(skill).not.toContain("Desktop/src");
		expect(skill).toContain("If `gh auth status` lists more than one account");
	});

	it("requires the preview URL to be opened before it is handed over", () => {
		const skill = getShareArtifactSkillContent();

		expect(skill).toContain("A link you have not opened is a guess.");
		expect(skill).toContain("https://htmlpreview.github.io/?https://gist.githubusercontent.com/");
	});
});

describe("managed skill installation surface", () => {
	it("installs the share-artifact skill for every supported agent", () => {
		for (const dir of [".claude", ".cursor", ".agents", ".codex", ".opencode", ".config/opencode"]) {
			expect(MANAGED_SKILL_FILES).toContain(`${dir}/skills/dev3-share-artifact/SKILL.md`);
		}
	});

	it("lists every managed skill exactly once so `dev3 install-skills` cannot drift", () => {
		expect(new Set(MANAGED_SKILL_FILES).size).toBe(MANAGED_SKILL_FILES.length);
		for (const name of ["dev3", "dev3-project-config", "dev3-tmux", "dev3-bug-hunter", "ask-dev3", "dev3-share-artifact"]) {
			expect(MANAGED_SKILL_FILES.some((file) => file.includes(`/skills/${name}/`))).toBe(true);
		}
	});
});

describe("ask-dev3 skill routing", () => {
	it("teaches sharing a report outside the app and lists the sibling skill", () => {
		const skill = getAskDev3SkillContent();

		expect(skill).toContain("Send a report to someone outside dev3 → ask for a link.");
		expect(skill).toContain("`/dev3-share-artifact`** — publish an HTML report as a gist");
	});
});
