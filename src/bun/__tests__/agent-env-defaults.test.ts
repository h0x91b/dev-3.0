import { describe, expect, it } from "vitest";
import { applyAgentEnvDefaults, PROJECT_CLAUDE_CONFIG_DIR_DEFAULT } from "../../shared/agent-env-defaults";

const project = { path: "/src/acme", name: "acme" };
const defaults = { CLAUDE_CONFIG_DIR: PROJECT_CLAUDE_CONFIG_DIR_DEFAULT, OTHER: "{projectName}" };

describe("applyAgentEnvDefaults and the per-project Claude folder", () => {
	it("points Claude at the project's .claude on macOS", () => {
		expect(applyAgentEnvDefaults({}, defaults, project, "/home/u", "darwin")).toEqual({ CLAUDE_CONFIG_DIR: "/src/acme/.claude", OTHER: "acme" });
	});

	it("drops that default where Claude Code would write its credentials into the folder", () => {
		for (const platform of ["linux", "win32"]) {
			expect(applyAgentEnvDefaults({}, defaults, project, "/home/u", platform)).toEqual({ OTHER: "acme" });
		}
	});

	it("leaves any other CLAUDE_CONFIG_DIR default alone on every platform", () => {
		const own = { CLAUDE_CONFIG_DIR: "{home}/.claude-projects/{projectName}" };
		expect(applyAgentEnvDefaults({}, own, project, "/home/u", "linux")).toEqual({ CLAUDE_CONFIG_DIR: "/home/u/.claude-projects/acme" });
	});
});
