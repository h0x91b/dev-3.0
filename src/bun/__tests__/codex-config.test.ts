import { describe, it, expect } from "vitest";
import { ensureCodexConfig } from "../codex-config";

describe("ensureCodexConfig", () => {
	const WORKTREES_PATH = "/Users/testuser/.dev3.0/worktrees";
	const SOCKETS_PATH = "/Users/testuser/.dev3.0/sockets";

	describe("when config does not exist", () => {
		it("creates config with project trust, workspace default permissions, permissions.dev3, and dev3 profiles", () => {
			const result = ensureCodexConfig(null, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain(`[projects."${WORKTREES_PATH}"]`);
			expect(result).toContain('trust_level = "trusted"');
			expect(result).toContain('default_permissions = "workspace"');
			expect(result).toContain("[permissions.workspace.filesystem]");
			expect(result).toContain('[permissions.workspace.filesystem.":workspace_roots"]');
			expect(result).toContain("[permissions.workspace.network]");
			// Permission profile
			expect(result).toContain("[permissions.dev3.filesystem]");
			expect(result).toContain('":minimal" = "read"');
			expect(result).toContain('"/Users/testuser/.codex/skills" = "read"');
			expect(result).toContain('"/Users/testuser/.agents/skills" = "read"');
			expect(result).toContain('"/Users/testuser/.dev3.0" = "write"');
			expect(result).toContain('[permissions.dev3.filesystem.":workspace_roots"]');
			expect(result).toContain('"." = "write"');
			expect(result).toContain("[permissions.dev3.network]");
			expect(result).toContain("enabled = true");
			expect(result).toContain(`allow_unix_sockets = ["${SOCKETS_PATH}"]`);
			// Config profile
			expect(result).toContain("[profiles.dev3]");
			expect(result).toContain('web_search = "live"');
			expect(result).toContain("[profiles.dev3-light]");
			expect(result).toContain("[profiles.dev3-dark]");
			expect(result).not.toContain('tui.theme = "github"');
			expect(result).not.toContain('tui.theme = "dracula"');
			expect(result).toContain("[features]");
			expect(result).toContain("hooks = true");
			expect(result).not.toContain("codex_hooks");
		});

		it("creates a generic workspace profile and uses it as default_permissions when missing", () => {
			const result = ensureCodexConfig(null, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain('default_permissions = "workspace"');
			expect(result).toContain("[permissions.workspace.filesystem]");
			expect(result).toContain('":minimal" = "read"');
			expect(result).toContain('[permissions.workspace.filesystem.":workspace_roots"]');
			expect(result).toContain('"." = "write"');
			expect(result).toContain("[permissions.workspace.network]");
			expect(result).toContain("enabled = true");
		});

		it("can trust an exact worktree path in addition to the shared worktrees root", () => {
			const worktreePath = "/Users/testuser/.dev3.0/worktrees/proj/abcd1234/worktree";
			const result = ensureCodexConfig(null, WORKTREES_PATH, SOCKETS_PATH, [worktreePath]);

			expect(result).toContain(`[projects."${WORKTREES_PATH}"]`);
			expect(result).toContain(`[projects."${worktreePath}"]`);
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

		it("adds default_permissions = workspace when permissions exist but no default is set", () => {
			const existing = `model = "gpt-5.4"

[permissions.dev3.filesystem]
":minimal" = "read"

[permissions.dev3.filesystem.":workspace_roots"]
"." = "write"

[permissions.dev3.network]
enabled = true
allow_unix_sockets = ["${SOCKETS_PATH}"]
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain('default_permissions = "workspace"');
			expect(result).toContain("[permissions.workspace.filesystem]");
			expect(result).toContain("[permissions.workspace.network]");
			expect(result).toContain("[permissions.dev3.network]");
		});

		it("fills missing workspace entries before setting default_permissions = workspace", () => {
			const existing = `[permissions.workspace.filesystem]
"/tmp/custom" = "read"

[permissions.workspace.network]
enabled = false
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain('default_permissions = "workspace"');
			expect(result).toContain("[permissions.workspace.filesystem]");
			expect(result).toContain('":minimal" = "read"');
			expect(result).toContain('[permissions.workspace.filesystem.":workspace_roots"]');
			expect(result).toContain('"." = "write"');
			expect(result).toContain("[permissions.workspace.network]");
			expect(result).toContain("enabled = true");
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

[permissions.dev3.filesystem.":workspace_roots"]
"." = "write"

[permissions.dev3.network]
enabled = true
allow_unix_sockets = ["${SOCKETS_PATH}"]

[profiles.dev3]
web_search = "live"

[profiles.dev3-light]
web_search = "live"
# tui.theme = "github"

[profiles.dev3-dark]
web_search = "live"
# tui.theme = "dracula"

[features]
hooks = true
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			const projectMatches = result.match(/\[projects\."[^"]*worktrees"\]/g);
			expect(projectMatches).toHaveLength(1);
			const netMatches = result.match(/\[permissions\.dev3\.network\]/g);
			expect(netMatches).toHaveLength(1);
			const profileMatches = result.match(/\[profiles\.dev3\]/g);
			expect(profileMatches).toHaveLength(1);
			const lightProfileMatches = result.match(/\[profiles\.dev3-light\]/g);
			expect(lightProfileMatches).toHaveLength(1);
			const darkProfileMatches = result.match(/\[profiles\.dev3-dark\]/g);
			expect(darkProfileMatches).toHaveLength(1);
			const featuresMatches = result.match(/\[features\]/g);
			expect(featuresMatches).toHaveLength(1);
		});
	});

	describe("when themed dev3 profiles exist with stale values", () => {
		it("comments out stale profile theme settings", () => {
			const existing = `[profiles.dev3-light]
web_search = "disabled"
tui.theme = "old-light"

[profiles.dev3-dark]
tui.theme = "old-dark"
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);

			expect(result).toContain("[profiles.dev3-light]");
			expect(result).toContain('web_search = "live"');
			expect(result).toContain("[profiles.dev3-dark]");
			expect(result).toContain('# tui.theme = "old-light"');
			expect(result).toContain('# tui.theme = "old-dark"');
			expect(result).not.toMatch(/^tui\.theme =/m);
		});
	});

	describe("when features section exists", () => {
		it("adds hooks without removing other feature flags", () => {
			const existing = `[features]
experimental_resume = true
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);

			expect(result).toContain("[features]");
			expect(result).toContain("experimental_resume = true");
			expect(result).toContain("hooks = true");
		});

		it("updates hooks to true when it was false", () => {
			const existing = `[features]
hooks = false
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);

			expect(result).toContain("hooks = true");
			expect(result).not.toContain("hooks = false");
		});

		it("renames deprecated codex_hooks → hooks", () => {
			const existing = `[features]
codex_hooks = true
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);

			expect(result).toContain("hooks = true");
			expect(result).not.toContain("codex_hooks");
		});

		it("drops codex_hooks when hooks is already present alongside it", () => {
			// Codex 0.133+ silently mirrors the deprecated alias into `hooks`,
			// so both keys can end up in the file at once.
			const existing = `[features]
codex_hooks = true
hooks = true
js_repl = false
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);

			expect(result).toContain("hooks = true");
			expect(result).toContain("js_repl = false");
			expect(result).not.toContain("codex_hooks");
			expect(result.match(/^hooks\s*=/gm)).toHaveLength(1);
		});
	});

	describe("legacy :project_roots migration", () => {
		it("renames dev3 :project_roots → :workspace_roots", () => {
			const existing = `[permissions.dev3.filesystem]
":minimal" = "read"

[permissions.dev3.filesystem.":project_roots"]
"." = "write"

[permissions.dev3.network]
enabled = true
allow_unix_sockets = ["${SOCKETS_PATH}"]
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);

			expect(result).toContain('[permissions.dev3.filesystem.":workspace_roots"]');
			expect(result).not.toContain(':project_roots');
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
		it("adds skill directory read permissions and dev3 data write access", () => {
			const existing = `[permissions.dev3.filesystem]
":minimal" = "read"

[permissions.dev3.filesystem.":project_roots"]
"." = "write"

[permissions.dev3.network]
enabled = true
allow_unix_sockets = ["${SOCKETS_PATH}"]
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain('"/Users/testuser/.codex/skills" = "read"');
			expect(result).toContain('"/Users/testuser/.agents/skills" = "read"');
			expect(result).toContain('"/Users/testuser/.dev3.0" = "write"');
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
			expect(result).toContain("[profiles.dev3-light]");
			expect(result).toContain("[profiles.dev3-dark]");
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
