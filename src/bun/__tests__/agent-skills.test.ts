import { describe, expect, it } from "vitest";
import {
	getBugHunterSkillContent,
	getClaudeSkillContent,
	getCodexSkillContent,
	getGenericSkillContent,
	getProjectConfigSkillContent,
	getTmuxSkillContent,
} from "../agent-skills";

describe("dev3 skill content", () => {
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
		for (const skill of [getClaudeSkillContent(), getCodexSkillContent(), getGenericSkillContent()]) {
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
		for (const skill of [getClaudeSkillContent(), getCodexSkillContent(), getGenericSkillContent()]) {
			expect(skill).toContain("same pass as the title and labels");
		}
	});

	it("keeps embedded label guidance consistent across agent variants", () => {
		expect(getClaudeSkillContent()).toContain("In the same session-start pass, also assign task labels:");
		expect(getGenericSkillContent()).toContain("In the same session-start pass, also assign task labels:");
		expect(getClaudeSkillContent()).toContain("reuse existing labels whenever possible.");
		expect(getGenericSkillContent()).toContain("reuse existing labels whenever possible.");
		expect(getClaudeSkillContent()).toContain("attach it to the current task immediately.");
		expect(getGenericSkillContent()).toContain("attach it to the current task immediately.");
	});

	it("adds conservative dev-server control guidance across agent variants", () => {
		expect(getCodexSkillContent()).toContain("## Dev Server Control");
		expect(getCodexSkillContent()).toContain("`dev3 dev-server status` is low-risk");
		expect(getCodexSkillContent()).toContain("Do not use them by default.");
		expect(getClaudeSkillContent()).toContain("Before doing so, briefly tell the user what you are about to do.");
		expect(getGenericSkillContent()).toContain("If you started the dev server only for verification, stop it afterwards");
	});

	it("teaches the agent to use the dev3 tmux session proactively (short summary)", () => {
		for (const skill of [getClaudeSkillContent(), getCodexSkillContent(), getGenericSkillContent()]) {
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
		for (const skill of [getClaudeSkillContent(), getCodexSkillContent(), getGenericSkillContent()]) {
			expect(skill).not.toContain("Open a pane or window and run a command");
			expect(skill).not.toContain("Resize a pane — absolute width / height");
			expect(skill).not.toContain("Re-tile all panes in the window");
		}
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
});
