import { describe, it, expect } from "vitest";
import { ensureCodexConfig, getCodexSyntaxForVersion, parseCodexVersion } from "../codex-config";

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
			expect(result).toContain('[permissions.workspace.filesystem.":project_roots"]');
			expect(result).toContain("[permissions.workspace.network]");
			// Permission profile
			expect(result).toContain("[permissions.dev3.filesystem]");
			expect(result).toContain('":minimal" = "read"');
			expect(result).toContain('"/Users/testuser/.codex/skills" = "read"');
			expect(result).toContain('"/Users/testuser/.agents/skills" = "read"');
			expect(result).toContain('"/Users/testuser/.dev3.0" = "write"');
			expect(result).toContain('[permissions.dev3.filesystem.":project_roots"]');
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
			expect(result).toContain("codex_hooks = true");
		});

		it("creates a generic workspace profile and uses it as default_permissions when missing", () => {
			const result = ensureCodexConfig(null, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain('default_permissions = "workspace"');
			expect(result).toContain("[permissions.workspace.filesystem]");
			expect(result).toContain('":minimal" = "read"');
			expect(result).toContain('[permissions.workspace.filesystem.":project_roots"]');
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

	describe("Codex version compatibility", () => {
		it("parses Codex CLI version output", () => {
			expect(parseCodexVersion("codex-cli 0.133.0")).toEqual({
				major: 0,
				minor: 133,
				patch: 0,
			});
			expect(parseCodexVersion("OpenAI Codex (v0.131.2)")).toEqual({
				major: 0,
				minor: 131,
				patch: 2,
			});
		});

		it("selects hooks before workspace_roots during the transition window", () => {
			expect(getCodexSyntaxForVersion("codex-cli 0.128.9")).toEqual({
				filesystemRootKey: ":project_roots",
				hooksFeatureKey: "codex_hooks",
			});
			expect(getCodexSyntaxForVersion("codex-cli 0.130.0")).toEqual({
				filesystemRootKey: ":project_roots",
				hooksFeatureKey: "hooks",
			});
			expect(getCodexSyntaxForVersion("codex-cli 0.131.0")).toEqual({
				filesystemRootKey: ":workspace_roots",
				hooksFeatureKey: "hooks",
			});
		});

		it("uses workspace_roots and hooks for Codex 0.131+", () => {
			const result = ensureCodexConfig(null, WORKTREES_PATH, SOCKETS_PATH, [], {
				codexVersion: "codex-cli 0.133.0",
			});

			expect(result).toContain('[permissions.workspace.filesystem.":workspace_roots"]');
			expect(result).toContain('[permissions.dev3.filesystem.":workspace_roots"]');
			expect(result).toContain("hooks = true");
			expect(result).not.toContain(":project_roots");
			expect(result).not.toMatch(/^codex_hooks\s*=/m);
		});

		it("keeps project_roots but uses hooks for Codex 0.129-0.130", () => {
			const result = ensureCodexConfig(null, WORKTREES_PATH, SOCKETS_PATH, [], {
				codexVersion: "codex-cli 0.130.0",
			});

			expect(result).toContain('[permissions.workspace.filesystem.":project_roots"]');
			expect(result).toContain('[permissions.dev3.filesystem.":project_roots"]');
			expect(result).toContain("hooks = true");
			expect(result).not.toContain(":workspace_roots");
			expect(result).not.toMatch(/^codex_hooks\s*=/m);
		});

		it("migrates managed legacy keys to current Codex syntax", () => {
			const existing = `[permissions.workspace.filesystem]
":minimal" = "read"

[permissions.workspace.filesystem.":project_roots"]
"." = "write"

[permissions.dev3.filesystem]
":minimal" = "read"

[permissions.dev3.filesystem.":project_roots"]
"." = "write"

[features]
codex_hooks = true
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH, [], {
				codexVersion: "codex-cli 0.133.0",
			});

			expect(result).toContain('[permissions.workspace.filesystem.":workspace_roots"]');
			expect(result).toContain('[permissions.dev3.filesystem.":workspace_roots"]');
			expect(result).toContain("hooks = true");
			expect(result).not.toContain(":project_roots");
			expect(result).not.toMatch(/^codex_hooks\s*=/m);
		});

		it("drops duplicate codex_hooks when hooks already exists for newer Codex", () => {
			const existing = `[features]
  codex_hooks = true
hooks = true
js_repl = false
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH, [], {
				codexVersion: "codex-cli 0.133.0",
			});

			expect(result).toContain("hooks = true");
			expect(result).toContain("js_repl = false");
			expect(result).not.toContain("codex_hooks");
			expect(result.match(/^[ \t]*hooks\s*=/gm)).toHaveLength(1);
		});

		it("migrates managed current keys back for older Codex versions", () => {
			const existing = `[permissions.workspace.filesystem]
":minimal" = "read"

[permissions.workspace.filesystem.":workspace_roots"]
"." = "write"

[permissions.dev3.filesystem]
":minimal" = "read"

[permissions.dev3.filesystem.":workspace_roots"]
"." = "write"

[features]
hooks = true
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH, [], {
				codexVersion: "codex-cli 0.128.0",
			});

			expect(result).toContain('[permissions.workspace.filesystem.":project_roots"]');
			expect(result).toContain('[permissions.dev3.filesystem.":project_roots"]');
			expect(result).toContain("codex_hooks = true");
			expect(result).not.toContain(":workspace_roots");
			expect(result).not.toMatch(/^hooks\s*=/m);
		});

		it("drops duplicate hooks when codex_hooks already exists for older Codex", () => {
			const existing = `[features]
  hooks = true
codex_hooks = true
js_repl = false
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH, [], {
				codexVersion: "codex-cli 0.128.0",
			});

			expect(result).toContain("codex_hooks = true");
			expect(result).toContain("js_repl = false");
			expect(result).not.toMatch(/^[ \t]*hooks\s*=/m);
			expect(result.match(/^[ \t]*codex_hooks\s*=/gm)).toHaveLength(1);
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

[permissions.dev3.filesystem.":project_roots"]
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
			expect(result).toContain('[permissions.workspace.filesystem.":project_roots"]');
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

[permissions.dev3.filesystem.":project_roots"]
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
codex_hooks = true
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
		it("adds codex_hooks without removing other feature flags", () => {
			const existing = `[features]
experimental_resume = true
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);

			expect(result).toContain("[features]");
			expect(result).toContain("experimental_resume = true");
			expect(result).toContain("codex_hooks = true");
		});

		it("updates codex_hooks to true when it was false", () => {
			const existing = `[features]
codex_hooks = false
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);

			expect(result).toContain("codex_hooks = true");
			expect(result).not.toContain("codex_hooks = false");
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
