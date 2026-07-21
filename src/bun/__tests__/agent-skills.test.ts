import { describe, expect, it } from "vitest";
import {
	applyClaudeSettings,
	CLAUDE_SKILL_BODY,
	getBugHunterSkillContent,
	getClaudeSkillContent,
	getCodexSkillContent,
	getGenericSkillContent,
	getProjectConfigSkillContent,
	getTmuxSkillContent,
} from "../agent-skills";

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

	it("routes unqualified artifacts to the task-local dev3 starter", () => {
		for (const skill of [CLAUDE_SKILL_BODY, getCodexSkillContent(), getGenericSkillContent()]) {
			expect(skill).toContain("## dev3 HTML artifacts");
			expect(skill).toContain("DEV3_ARTIFACT_TEMPLATE_DIR");
			expect(skill).toContain("Copy the entire template directory");
			expect(skill).toContain("Read `AUTHORING.md`");
			expect(skill).toContain("Claude Artifacts");
			expect(skill).toContain("dev3 show-artifact");
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

	it("gates completion on a pull request merged into main", () => {
		for (const skill of [CLAUDE_SKILL_BODY, getCodexSkillContent(), getGenericSkillContent()]) {
			expect(skill).toContain("Never move a task to `completed`, and never request the completion approval");
			expect(skill).toContain("pull request has been merged into `main`");
			expect(skill).toContain("A local commit, passing tests, or an open/unmerged pull request is not sufficient");
		}
	});

	it("adds conservative dev-server control guidance across agent variants", () => {
		expect(getCodexSkillContent()).toContain("## Dev Server Control");
		expect(getCodexSkillContent()).toContain("`dev3 dev-server status` is low-risk");
		expect(getCodexSkillContent()).toContain("Do not use them by default.");
		expect(CLAUDE_SKILL_BODY).toContain("Before doing so, briefly tell the user what you are about to do.");
		expect(getGenericSkillContent()).toContain("If you started the dev server only for verification, stop it afterwards");
	});

	it("teaches the agent to use the dev3 tmux session proactively (short summary)", () => {
		for (const skill of [CLAUDE_SKILL_BODY, getCodexSkillContent(), getGenericSkillContent()]) {
			expect(skill).toContain("## tmux — use it proactively");
			expect(skill).toContain("socket `dev3`");
			expect(skill).toContain("dev3-<first 8 chars of task ID>");
			expect(skill).toContain("tmux -L dev3 display-message -p '#S #I #P'");
			expect(skill).toContain("list-windows");
			expect(skill).toContain("list-panes");
			expect(skill).toContain("Always use `-L dev3`");
			expect(skill).toContain("pass `Enter` as a separate argument");
			// Short version points to the full skill for deeper guidance
			expect(skill).toContain("/dev3-tmux");
		}
	});

	it("keeps the main /dev3 tmux summary short (does not duplicate the full reference)", () => {
		// The detailed command reference must live in the separate /dev3-tmux skill,
		// not be duplicated inline in the main skill body.
		for (const skill of [CLAUDE_SKILL_BODY, getCodexSkillContent(), getGenericSkillContent()]) {
			expect(skill).not.toContain("Open a pane or window and run a command");
			expect(skill).not.toContain("Resize a pane — absolute width / height");
			expect(skill).not.toContain("Re-tile all panes in the window");
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
