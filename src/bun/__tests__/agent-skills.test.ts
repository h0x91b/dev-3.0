import { describe, expect, it } from "vitest";
import { getProjectConfigSkillContent } from "../agent-skills";

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
