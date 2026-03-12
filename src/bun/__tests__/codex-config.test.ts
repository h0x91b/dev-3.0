import { describe, it, expect } from "vitest";
import { ensureCodexConfig } from "../codex-config";

describe("ensureCodexConfig", () => {
	const WORKTREES_PATH = "/Users/testuser/.dev3.0/worktrees";
	const SOCKETS_PATH = "/Users/testuser/.dev3.0/sockets";

	describe("when config does not exist", () => {
		it("creates config with project trust, default_permissions, filesystem, and workspace network", () => {
			const result = ensureCodexConfig(null, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain(`[projects."${WORKTREES_PATH}"]`);
			expect(result).toContain('trust_level = "trusted"');
			expect(result).toContain('default_permissions = "workspace"');
			expect(result).toContain("[permissions.workspace.filesystem]");
			expect(result).toContain('":minimal" = "read"');
			expect(result).toContain('[permissions.workspace.filesystem.":project_roots"]');
			expect(result).toContain('"." = "write"');
			expect(result).toContain("[permissions.workspace.network]");
			expect(result).toContain("enabled = true");
			expect(result).toContain(`allow_unix_sockets = ["${SOCKETS_PATH}"]`);
		});
	});

	describe("when config exists but has no dev3 settings", () => {
		it("appends project, default_permissions, and workspace permissions to existing config", () => {
			const existing = `model = "gpt-5.4"
model_reasoning_effort = "medium"

[projects."/Users/testuser/my-project"]
trust_level = "trusted"
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain('model = "gpt-5.4"');
			expect(result).toContain('[projects."/Users/testuser/my-project"]');
			expect(result).toContain(`[projects."${WORKTREES_PATH}"]`);
			expect(result).toContain('default_permissions = "workspace"');
			expect(result).toContain("[permissions.workspace.network]");
			expect(result).toContain("enabled = true");
			expect(result).toContain(`allow_unix_sockets = ["${SOCKETS_PATH}"]`);
		});
	});

	describe("when config already has all dev3 settings", () => {
		it("does not duplicate entries", () => {
			const existing = `default_permissions = "workspace"
model = "gpt-5.4"

[projects."${WORKTREES_PATH}"]
trust_level = "trusted"

[permissions.workspace.filesystem]
":minimal" = "read"

[permissions.workspace.filesystem.":project_roots"]
"." = "write"

[permissions.workspace.network]
enabled = true
allow_unix_sockets = ["${SOCKETS_PATH}"]
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			const projectMatches = result.match(/\[projects\."[^"]*worktrees"\]/g);
			expect(projectMatches).toHaveLength(1);
			const netMatches = result.match(/\[permissions\.workspace\.network\]/g);
			expect(netMatches).toHaveLength(1);
		});
	});

	describe("when config has workspace network but no allow_unix_sockets", () => {
		it("adds allow_unix_sockets to existing workspace network section", () => {
			const existing = `default_permissions = "workspace"

[permissions.workspace.network]
enabled = true
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain("enabled = true");
			expect(result).toContain(`allow_unix_sockets = ["${SOCKETS_PATH}"]`);
			const sectionMatches = result.match(/\[permissions\.workspace\.network\]/g);
			expect(sectionMatches).toHaveLength(1);
		});
	});

	describe("when config has workspace network with different allow_unix_sockets", () => {
		it("adds sockets path to existing array", () => {
			const existing = `default_permissions = "workspace"

[permissions.workspace.network]
enabled = true
allow_unix_sockets = ["/tmp/other.sock"]
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain(`allow_unix_sockets = ["/tmp/other.sock", "${SOCKETS_PATH}"]`);
		});
	});

	describe("when config has workspace network with sockets path already present", () => {
		it("does not duplicate the sockets path", () => {
			const existing = `default_permissions = "workspace"

[permissions.workspace.network]
enabled = true
allow_unix_sockets = ["${SOCKETS_PATH}"]
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			const sockMatches = result.match(new RegExp(SOCKETS_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"));
			expect(sockMatches).toHaveLength(1);
		});
	});

	describe("when config has workspace network without enabled", () => {
		it("adds enabled = true", () => {
			const existing = `default_permissions = "workspace"

[permissions.workspace.network]
allow_unix_sockets = ["${SOCKETS_PATH}"]
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain("enabled = true");
		});
	});

	describe("when config already has default_permissions set to something else", () => {
		it("overwrites to workspace", () => {
			const existing = `default_permissions = "read-only"
model = "gpt-5.4"
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain('default_permissions = "workspace"');
			expect(result).not.toContain('default_permissions = "read-only"');
		});
	});

	describe("old [permissions.network] cleanup", () => {
		it("removes old-style [permissions.network] with dev3 sockets and adds new workspace syntax", () => {
			const existing = `model = "gpt-5.4"

[permissions.network]
enabled = true
allow_unix_sockets = ["${SOCKETS_PATH}"]

[projects."/Users/testuser/my-project"]
trust_level = "trusted"
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).not.toContain("[permissions.network]");
			expect(result).toContain("[permissions.workspace.network]");
			expect(result).toContain('default_permissions = "workspace"');
			expect(result).toContain('[projects."/Users/testuser/my-project"]');
		});

		it("does not remove [permissions.network] without dev3 sockets", () => {
			const existing = `model = "gpt-5.4"

[permissions.network]
enabled = true
allow_unix_sockets = ["/tmp/other.sock"]
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			// Old section without dev3 sockets is preserved
			expect(result).toContain("[permissions.network]");
			// New workspace section is still added
			expect(result).toContain("[permissions.workspace.network]");
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
			expect(result).toContain("[permissions.workspace.network]");
			expect(result).toContain('default_permissions = "workspace"');
		});

		it("handles config with only whitespace", () => {
			const result = ensureCodexConfig("  \n\n  ", WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain(`[projects."${WORKTREES_PATH}"]`);
			expect(result).toContain('default_permissions = "workspace"');
		});

		it("handles config ending without newline", () => {
			const existing = 'model = "gpt-5.4"';
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain('model = "gpt-5.4"');
			expect(result).toContain(`[projects."${WORKTREES_PATH}"]`);
			expect(result).toContain('default_permissions = "workspace"');
		});

		it("returns unparseable config unchanged", () => {
			const broken = "this is not valid toml [[[";
			const result = ensureCodexConfig(broken, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toBe(broken);
		});
	});
});
