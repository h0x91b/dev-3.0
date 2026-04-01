import { describe, expect, it } from "vitest";
import {
	getClaudeSkillContent,
	getCodexSkillContent,
	getGenericSkillContent,
	getProjectConfigSkillContent,
} from "../agent-skills";

describe("dev3 skill content", () => {
	it("encourages active label usage without label spam", () => {
		expect(getCodexSkillContent()).toContain(
			"Aim for **1-2 meaningful labels per task** in the normal case",
		);
		expect(getCodexSkillContent()).toContain("dev3 label list");
		expect(getCodexSkillContent()).toContain('dev3 label create "name"');
		expect(getCodexSkillContent()).toContain("dev3 label set <id> [<id>...]");
		expect(getCodexSkillContent()).toContain(
			"Do not create more than one new label for a task unless there is a strong project-specific reason.",
		);
	});

	it("keeps label guidance consistent across agent variants", () => {
		expect(getClaudeSkillContent()).toContain("## Task labels");
		expect(getGenericSkillContent()).toContain("## Task labels");
		expect(getClaudeSkillContent()).toContain("Reuse existing labels whenever possible.");
		expect(getGenericSkillContent()).toContain("Reuse existing labels whenever possible.");
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
