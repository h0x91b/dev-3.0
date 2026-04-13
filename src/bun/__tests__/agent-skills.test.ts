import { describe, expect, it } from "vitest";
import {
	getBugHunterSkillContent,
	getClaudeSkillContent,
	getCodexSkillContent,
	getGenericSkillContent,
	getProjectConfigSkillContent,
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
		expect(skill).toContain("| Severity | File | Lines | Summary | Why it breaks | Reproduction hint |");
		expect(skill).toContain("Severity` must be one of: `critical`, `high`, `medium`");
		expect(skill).toContain("I can write reproduction tests for the strongest finding if you want a validation pass.");
	});
});
