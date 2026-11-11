import { describe, expect, it } from "vitest";
import { applyAgentEnvDefaults, PROJECT_CLAUDE_CONFIG_DIR_DEFAULT, usesProjectClaudeConfigDir } from "../../shared/agent-env-defaults";

const project = { path: "/src/acme", name: "acme" };
const defaults = { CLAUDE_CONFIG_DIR: PROJECT_CLAUDE_CONFIG_DIR_DEFAULT, OTHER: "{projectName}" };

describe("applyAgentEnvDefaults and the per-project Claude folder", () => {
	it("points Claude at the project's .claude when the host allows it", () => {
		expect(applyAgentEnvDefaults({}, defaults, project, "/home/u", () => true)).toEqual({ CLAUDE_CONFIG_DIR: "/src/acme/.claude", OTHER: "acme" });
	});

	it("drops a project-relative default the host refuses, in any spelling", () => {
		const seen: string[] = [];
		const refuse = (dir: string) => (seen.push(dir), false);
		for (const value of [PROJECT_CLAUDE_CONFIG_DIR_DEFAULT, "{projectPath}/.claude/", "{projectPath}/cfg"]) {
			expect(applyAgentEnvDefaults({}, { ...defaults, CLAUDE_CONFIG_DIR: value }, project, "/home/u", refuse)).toEqual({ OTHER: "acme" });
		}
		expect(seen).toEqual(["/src/acme/.claude", "/src/acme/.claude/", "/src/acme/cfg"]);
	});

	it("never asks about a CLAUDE_CONFIG_DIR default outside the project", () => {
		const own = { CLAUDE_CONFIG_DIR: "{home}/.claude-projects/{projectName}" };
		expect(applyAgentEnvDefaults({}, own, project, "/home/u", () => false)).toEqual({ CLAUDE_CONFIG_DIR: "/home/u/.claude-projects/acme" });
	});

	it("never asks when the project sets CLAUDE_CONFIG_DIR itself", () => {
		const env = { CLAUDE_CONFIG_DIR: "/own" };
		expect(applyAgentEnvDefaults(env, defaults, project, "/home/u", () => { throw new Error("asked"); })).toEqual({ ...env, OTHER: "acme" });
	});
});

describe("usesProjectClaudeConfigDir", () => {
	it("recognizes the default with trailing or Windows separators", () => {
		for (const value of ["{projectPath}/.claude", "{projectPath}/.claude/", "{projectPath}\\.claude\\"]) {
			expect(usesProjectClaudeConfigDir({ CLAUDE_CONFIG_DIR: value })).toBe(true);
		}
		expect(usesProjectClaudeConfigDir({ CLAUDE_CONFIG_DIR: "{projectPath}/.claude-x" })).toBe(false);
		expect(usesProjectClaudeConfigDir(undefined)).toBe(false);
	});
});
