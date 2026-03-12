import { describe, it, expect } from "vitest";
import { ensureCodexConfig } from "../codex-config";

describe("ensureCodexConfig", () => {
	const WORKTREES_PATH = "/Users/testuser/.dev3.0/worktrees";
	const SOCKETS_PATH = "/Users/testuser/.dev3.0/sockets";

	describe("when config does not exist", () => {
		it("creates config with project trust, permissions.dev3, and profiles.dev3", () => {
			const result = ensureCodexConfig(null, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain(`[projects."${WORKTREES_PATH}"]`);
			expect(result).toContain('trust_level = "trusted"');
			// Permission profile
			expect(result).toContain("[permissions.dev3.filesystem]");
			expect(result).toContain('":minimal" = "read"');
			expect(result).toContain('"~/.codex/skills" = "read"');
			expect(result).toContain('"~/.agents/skills" = "read"');
			expect(result).toContain('[permissions.dev3.filesystem.":project_roots"]');
			expect(result).toContain('"." = "write"');
			expect(result).toContain("[permissions.dev3.network]");
			expect(result).toContain("enabled = true");
			expect(result).toContain(`allow_unix_sockets = ["${SOCKETS_PATH}"]`);
			// Config profile
			expect(result).toContain("[profiles.dev3]");
			expect(result).toContain('web_search = "live"');
		});

		it("does NOT set default_permissions", () => {
			const result = ensureCodexConfig(null, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).not.toContain("default_permissions");
		});
	});

	describe("when config exists with user settings", () => {
		it("preserves user's default_permissions and adds dev3 profiles", () => {
			const existing = `model = "gpt-5.4"
default_permissions = "workspace"

[projects."/Users/testuser/my-project"]
trust_level = "trusted"
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain('default_permissions = "workspace"');
			expect(result).toContain('[projects."/Users/testuser/my-project"]');
			expect(result).toContain(`[projects."${WORKTREES_PATH}"]`);
			expect(result).toContain("[permissions.dev3.network]");
			expect(result).toContain("[profiles.dev3]");
		});
	});

	describe("when config already has dev3 profiles", () => {
		it("does not duplicate entries", () => {
			const existing = `model = "gpt-5.4"

[projects."${WORKTREES_PATH}"]
trust_level = "trusted"

[permissions.dev3.filesystem]
":minimal" = "read"
"~/.codex/skills" = "read"
"~/.agents/skills" = "read"

[permissions.dev3.filesystem.":project_roots"]
"." = "write"

[permissions.dev3.network]
enabled = true
allow_unix_sockets = ["${SOCKETS_PATH}"]

[profiles.dev3]
web_search = "live"
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			const projectMatches = result.match(/\[projects\."[^"]*worktrees"\]/g);
			expect(projectMatches).toHaveLength(1);
			const netMatches = result.match(/\[permissions\.dev3\.network\]/g);
			expect(netMatches).toHaveLength(1);
			const profileMatches = result.match(/\[profiles\.dev3\]/g);
			expect(profileMatches).toHaveLength(1);
		});
	});

	describe("when dev3 permission profile exists but missing socket", () => {
		it("adds socket path to existing network section", () => {
			const existing = `[permissions.dev3.filesystem]
":minimal" = "read"
"~/.codex/skills" = "read"
"~/.agents/skills" = "read"

[permissions.dev3.filesystem.":project_roots"]
"." = "write"

[permissions.dev3.network]
enabled = true
allow_unix_sockets = ["/tmp/other.sock"]
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain(`allow_unix_sockets = ["/tmp/other.sock", "${SOCKETS_PATH}"]`);
		});
	});

	describe("when dev3 permission profile exists but missing skill dirs", () => {
		it("adds skill directory read permissions", () => {
			const existing = `[permissions.dev3.filesystem]
":minimal" = "read"

[permissions.dev3.filesystem.":project_roots"]
"." = "write"

[permissions.dev3.network]
enabled = true
allow_unix_sockets = ["${SOCKETS_PATH}"]
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain('"~/.codex/skills" = "read"');
			expect(result).toContain('"~/.agents/skills" = "read"');
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
			expect(result).toContain("[permissions.dev3.network]");
			expect(result).toContain("[profiles.dev3]");
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

		it("returns unparseable config unchanged", () => {
			const broken = "this is not valid toml [[[";
			const result = ensureCodexConfig(broken, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toBe(broken);
		});
	});
});
