import { describe, it, expect } from "vitest";
import { ensureCodexConfig } from "../codex-config";

describe("ensureCodexConfig", () => {
	const WORKTREES_PATH = "/Users/testuser/.dev3.0/worktrees";
	const SOCKETS_PATH = "/Users/testuser/.dev3.0/sockets";

	describe("when config does not exist", () => {
		it("creates config with project, permissions.network, and worktrees trust", () => {
			const result = ensureCodexConfig(null, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain(`[projects."${WORKTREES_PATH}"]`);
			expect(result).toContain('trust_level = "trusted"');
			expect(result).toContain("[permissions.network]");
			expect(result).toContain("enabled = true");
			expect(result).toContain(`allow_unix_sockets = ["${SOCKETS_PATH}"]`);
		});
	});

	describe("when config exists but has no dev3 settings", () => {
		it("appends project and permissions.network to existing config", () => {
			const existing = `model = "gpt-5.4"
model_reasoning_effort = "medium"

[projects."/Users/testuser/my-project"]
trust_level = "trusted"
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			// Preserves existing content
			expect(result).toContain('model = "gpt-5.4"');
			expect(result).toContain('[projects."/Users/testuser/my-project"]');
			// Adds dev3 settings
			expect(result).toContain(`[projects."${WORKTREES_PATH}"]`);
			expect(result).toContain("[permissions.network]");
			expect(result).toContain("enabled = true");
			expect(result).toContain(`allow_unix_sockets = ["${SOCKETS_PATH}"]`);
		});
	});

	describe("when config already has dev3 worktrees project", () => {
		it("does not duplicate the project entry", () => {
			const existing = `model = "gpt-5.4"

[projects."${WORKTREES_PATH}"]
trust_level = "trusted"

[permissions.network]
enabled = true
allow_unix_sockets = ["${SOCKETS_PATH}"]
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			const matches = result.match(new RegExp(WORKTREES_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"));
			// worktrees path appears in project header + sockets path in allow_unix_sockets = 2 total from dev3.0 home
			expect(matches).not.toBeNull();
			// Should not have duplicate [projects."...worktrees"]
			const projectMatches = result.match(/\[projects\."[^"]*worktrees"\]/g);
			expect(projectMatches).toHaveLength(1);
		});
	});

	describe("when config has permissions.network but no allow_unix_sockets", () => {
		it("adds allow_unix_sockets to existing permissions.network section", () => {
			const existing = `model = "gpt-5.4"

[permissions.network]
enabled = true
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain("enabled = true");
			expect(result).toContain(`allow_unix_sockets = ["${SOCKETS_PATH}"]`);
			// Should not duplicate [permissions.network]
			const sectionMatches = result.match(/\[permissions\.network\]/g);
			expect(sectionMatches).toHaveLength(1);
		});
	});

	describe("when config has permissions.network with different allow_unix_sockets", () => {
		it("adds sockets path to existing array", () => {
			const existing = `model = "gpt-5.4"

[permissions.network]
enabled = true
allow_unix_sockets = ["/tmp/other.sock"]
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain(`allow_unix_sockets = ["/tmp/other.sock", "${SOCKETS_PATH}"]`);
		});
	});

	describe("when config has permissions.network with sockets path already present", () => {
		it("does not duplicate the sockets path", () => {
			const existing = `model = "gpt-5.4"

[permissions.network]
enabled = true
allow_unix_sockets = ["${SOCKETS_PATH}"]
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			const sockMatches = result.match(new RegExp(SOCKETS_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"));
			expect(sockMatches).toHaveLength(1);
		});
	});

	describe("when config has permissions.network without enabled", () => {
		it("adds enabled = true", () => {
			const existing = `model = "gpt-5.4"

[permissions.network]
allow_unix_sockets = ["${SOCKETS_PATH}"]
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain("enabled = true");
		});
	});

	describe("preserves comments", () => {
		it("does not strip comments from existing config", () => {
			const existing = `# My codex config
model = "gpt-5.4"

# MCP servers
[mcp_servers.playwright]
command = "npx"
args = ["@playwright/mcp@latest"]

# Disabled for now
# [mcp_servers.vibe_kanban]
# command = "npx"
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain("# My codex config");
			expect(result).toContain("# MCP servers");
			expect(result).toContain("# Disabled for now");
			expect(result).toContain("# [mcp_servers.vibe_kanban]");
		});
	});

	describe("preserves user's existing projects", () => {
		it("does not modify other project entries", () => {
			const existing = `[projects."/Users/testuser/my-app"]
trust_level = "trusted"
sandbox_mode = "workspace-write"

[projects."/Users/testuser/other"]
trust_level = "trusted"
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain('[projects."/Users/testuser/my-app"]');
			expect(result).toContain('sandbox_mode = "workspace-write"');
			expect(result).toContain('[projects."/Users/testuser/other"]');
		});
	});

	describe("handles edge cases", () => {
		it("handles empty string config", () => {
			const result = ensureCodexConfig("", WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain(`[projects."${WORKTREES_PATH}"]`);
			expect(result).toContain("[permissions.network]");
		});

		it("handles config with only whitespace", () => {
			const result = ensureCodexConfig("  \n\n  ", WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain(`[projects."${WORKTREES_PATH}"]`);
		});

		it("handles config ending without newline", () => {
			const existing = 'model = "gpt-5.4"';
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain('model = "gpt-5.4"');
			expect(result).toContain(`[projects."${WORKTREES_PATH}"]`);
		});
	});
});
