import { describe, it, expect } from "vitest";
import {
	ensureCodexConfig,
	ensureCodexProfileFile,
	getCodexSyntaxForVersion,
	parseCodexVersion,
	pickCodexProfileLaunchFlag,
	tomlBasicString,
} from "../codex-config";
import { codexHookCommand } from "../../shared/agent-hooks";
import { hookCliDialect } from "../../shared/dev3-cli-path";

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

		describe("pickCodexProfileLaunchFlag (issue #611)", () => {
			it("prefers --profile-v2 when the help text lists both flags (transition window)", () => {
				const help = [
					"Options:",
					"  -p, --profile <CONFIG_PROFILE>      Configuration profile",
					"      --profile-v2 <CONFIG_PROFILE_V2>  File-based profile",
				].join("\n");
				expect(pickCodexProfileLaunchFlag(help)).toBe("--profile-v2");
			});

			it("uses --profile when --profile-v2 was removed (codex >= post-rename)", () => {
				const help = [
					"Options:",
					"  -p, --profile <CONFIG_PROFILE_V2>  Configuration profile",
				].join("\n");
				expect(pickCodexProfileLaunchFlag(help)).toBe("--profile");
			});

			it("uses --profile for legacy help that only lists --profile", () => {
				const help = "  -p, --profile <CONFIG_PROFILE>  Configuration profile to use";
				expect(pickCodexProfileLaunchFlag(help)).toBe("--profile");
			});

			it("does not match a --profile-v2-foo substring as --profile-v2", () => {
				const help = "  --profile-v2-foo <X>  unrelated flag";
				expect(pickCodexProfileLaunchFlag(help)).toBe("--profile");
			});

			it("falls back to --profile when help is empty", () => {
				expect(pickCodexProfileLaunchFlag("")).toBe("--profile");
			});
		});

		it("selects hooks before workspace_roots during the transition window", () => {
			expect(getCodexSyntaxForVersion("codex-cli 0.128.9")).toEqual({
				filesystemRootKey: ":project_roots",
				hooksFeatureKey: "codex_hooks",
				profileV2: false,
				unixSocketsAsMap: true,
			});
			expect(getCodexSyntaxForVersion("codex-cli 0.130.0")).toEqual({
				filesystemRootKey: ":project_roots",
				hooksFeatureKey: "hooks",
				profileV2: false,
				unixSocketsAsMap: true,
			});
			expect(getCodexSyntaxForVersion("codex-cli 0.131.0")).toEqual({
				filesystemRootKey: ":workspace_roots",
				hooksFeatureKey: "hooks",
				profileV2: false,
				unixSocketsAsMap: true,
			});
			expect(getCodexSyntaxForVersion("codex-cli 0.133.9").profileV2).toBe(false);
			expect(getCodexSyntaxForVersion("codex-cli 0.134.0").profileV2).toBe(true);
		});

		it("switches the unix-socket allowlist to map form at codex 0.119", () => {
			expect(getCodexSyntaxForVersion("codex-cli 0.118.9").unixSocketsAsMap).toBe(false);
			expect(getCodexSyntaxForVersion("codex-cli 0.119.0").unixSocketsAsMap).toBe(true);
			expect(getCodexSyntaxForVersion(null).unixSocketsAsMap).toBe(false);
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

	describe("profile-v2 (Codex ≥0.134)", () => {
		it("does not emit [profiles.dev3*] blocks in the main config", () => {
			const result = ensureCodexConfig(null, WORKTREES_PATH, SOCKETS_PATH, [], {
				codexVersion: "codex-cli 0.134.0",
			});

			expect(result).not.toMatch(/^\[profiles\.dev3\]/m);
			expect(result).not.toMatch(/^\[profiles\.dev3-light\]/m);
			expect(result).not.toMatch(/^\[profiles\.dev3-dark\]/m);
			// Permissions and trust still patched
			expect(result).toContain("[permissions.dev3.network]");
			expect(result).toContain(`[projects."${WORKTREES_PATH}"]`);
		});

		it("removes pre-existing [profiles.dev3*] blocks when upgrading to v2", () => {
			const existing = `model = "gpt-5.4"

[profiles.dev3]
web_search = "live"

[profiles.dev3-light]
web_search = "live"
# tui.theme = "github"

[profiles.dev3-dark]
web_search = "live"

[profiles.ro]
sandbox_mode = "read-only"
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH, [], {
				codexVersion: "codex-cli 0.134.0",
			});

			expect(result).not.toMatch(/^\[profiles\.dev3\]/m);
			expect(result).not.toMatch(/^\[profiles\.dev3-light\]/m);
			expect(result).not.toMatch(/^\[profiles\.dev3-dark\]/m);
			// User's own profile preserved
			expect(result).toContain("[profiles.ro]");
			expect(result).toContain('sandbox_mode = "read-only"');
		});

		it("strips top-level profile = \"dev3*\" selector when on v2", () => {
			const existing = `model = "gpt-5.4"
profile = "dev3-light"

[projects."/Users/testuser/app"]
trust_level = "trusted"
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH, [], {
				codexVersion: "codex-cli 0.134.0",
			});

			expect(result).not.toMatch(/^profile\s*=\s*"dev3-light"/m);
			expect(result).toContain('model = "gpt-5.4"');
			expect(result).toContain('[projects."/Users/testuser/app"]');
		});

		it("removes nested managed profile tables while preserving user profiles", () => {
			const existing = `model = "gpt-5.4"

[profiles.dev3-dark]
web_search = "live"

[profiles.dev3-dark.tui]
theme = "dracula"

[profiles.dev3-light.tui]
theme = "github"

[profiles.dev3-dark-custom]
web_search = "disabled"

[profiles.ro]
sandbox_mode = "read-only"
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH, [], {
				codexVersion: "codex-cli 0.134.0",
			});

			expect(result).not.toContain("[profiles.dev3-dark]");
			expect(result).not.toContain("[profiles.dev3-dark.tui]");
			expect(result).not.toContain("[profiles.dev3-light.tui]");
			expect(result).toContain("[profiles.dev3-dark-custom]");
			expect(result).toContain("[profiles.ro]");
		});

		it("does not strip an unrelated top-level profile selector", () => {
			const existing = `profile = "my-custom"
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH, [], {
				codexVersion: "codex-cli 0.134.0",
			});

			expect(result).toContain('profile = "my-custom"');
		});

		it("legacy Codex (<0.134) still gets [profiles.dev3*] in main config", () => {
			const result = ensureCodexConfig(null, WORKTREES_PATH, SOCKETS_PATH, [], {
				codexVersion: "codex-cli 0.130.0",
			});

			expect(result).toContain("[profiles.dev3]");
			expect(result).toContain("[profiles.dev3-light]");
			expect(result).toContain("[profiles.dev3-dark]");
		});
	});

	describe("ensureCodexProfileFile", () => {
		it("creates a per-profile file from null content", () => {
			const result = ensureCodexProfileFile(null, { web_search: '"live"' });
			expect(result).toContain('web_search = "live"');
			expect(result.endsWith("\n")).toBe(true);
		});

		it("preserves unrelated user content", () => {
			const existing = `model = "gpt-5.4"
sandbox_mode = "workspace-write"
`;
			const result = ensureCodexProfileFile(existing, { web_search: '"live"' });
			expect(result).toContain('model = "gpt-5.4"');
			expect(result).toContain('sandbox_mode = "workspace-write"');
			expect(result).toContain('web_search = "live"');
		});

		it("upserts an existing key rather than duplicating it", () => {
			const existing = `web_search = "disabled"
`;
			const result = ensureCodexProfileFile(existing, { web_search: '"live"' });
			expect(result.match(/^web_search\s*=/gm)).toHaveLength(1);
			expect(result).toContain('web_search = "live"');
			expect(result).not.toContain('web_search = "disabled"');
		});
	});
});

describe("ensureCodexConfig unix-socket allowlist (codex >= 0.119 map form)", () => {
	const WORKTREES_PATH = "/Users/testuser/.dev3.0/worktrees";
	const SOCKETS_PATH = "/Users/testuser/.dev3.0/sockets";
	const NEW = { codexVersion: "0.141.0" };
	const count = (hay: string, needle: string) => hay.split(needle).length - 1;

	it("writes the unix_sockets map (not the legacy array) on a fresh config", () => {
		const result = ensureCodexConfig(null, WORKTREES_PATH, SOCKETS_PATH, [], NEW);
		expect(result).toContain("[permissions.dev3.network]");
		expect(result).toContain("enabled = true");
		expect(result).toContain("[permissions.dev3.network.unix_sockets]");
		expect(result).toContain(`"${SOCKETS_PATH}" = "allow"`);
		expect(result).not.toContain("allow_unix_sockets");
	});

	it("keeps the legacy array form when the codex version is below 0.119", () => {
		const result = ensureCodexConfig(null, WORKTREES_PATH, SOCKETS_PATH, [], { codexVersion: "0.118.0" });
		expect(result).toContain(`allow_unix_sockets = ["${SOCKETS_PATH}"]`);
		expect(result).not.toContain("[permissions.dev3.network.unix_sockets]");
	});

	it("defaults to the legacy array form when the codex version is unknown", () => {
		const result = ensureCodexConfig(null, WORKTREES_PATH, SOCKETS_PATH);
		expect(result).toContain(`allow_unix_sockets = ["${SOCKETS_PATH}"]`);
		expect(result).not.toContain("[permissions.dev3.network.unix_sockets]");
	});

	it("migrates a stale legacy array to the map and drops the array line", () => {
		const existing = `[permissions.dev3.filesystem]
":minimal" = "read"

[permissions.dev3.filesystem.":project_roots"]
"." = "write"

[permissions.dev3.network]
enabled = true
allow_unix_sockets = ["${SOCKETS_PATH}"]
`;
		const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH, [], NEW);
		expect(result).not.toContain("allow_unix_sockets");
		expect(result).toContain("[permissions.dev3.network.unix_sockets]");
		expect(result).toContain(`"${SOCKETS_PATH}" = "allow"`);
		// The network table still carries enabled = true after the array is stripped.
		expect(result).toMatch(/\[permissions\.dev3\.network\]\nenabled = true/);
	});

	it("preserves a foreign socket from the legacy array during migration", () => {
		const existing = `[permissions.dev3.network]
enabled = true
allow_unix_sockets = ["/tmp/other.sock"]
`;
		const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH, [], NEW);
		expect(result).not.toContain("allow_unix_sockets =");
		expect(result).toContain(`"${SOCKETS_PATH}" = "allow"`);
		expect(result).toContain('"/tmp/other.sock" = "allow"');
	});

	it("adds the socket to an existing unix_sockets map that lacks it", () => {
		const existing = `[permissions.dev3.network]
enabled = true

[permissions.dev3.network.unix_sockets]
"/tmp/other.sock" = "allow"
`;
		const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH, [], NEW);
		expect(result).toContain('"/tmp/other.sock" = "allow"');
		expect(result).toContain(`"${SOCKETS_PATH}" = "allow"`);
		expect(count(result, "[permissions.dev3.network.unix_sockets]")).toBe(1);
	});

	it("is idempotent — a second pass adds no duplicate map table or entry", () => {
		const once = ensureCodexConfig(null, WORKTREES_PATH, SOCKETS_PATH, [], NEW);
		const twice = ensureCodexConfig(once, WORKTREES_PATH, SOCKETS_PATH, [], NEW);
		expect(count(twice, "[permissions.dev3.network.unix_sockets]")).toBe(1);
		expect(count(twice, `"${SOCKETS_PATH}" = "allow"`)).toBe(1);
		expect(twice).not.toContain("allow_unix_sockets");
	});
});

/**
 * The hook command is spelled per platform, so these run against BOTH dialects
 * on every runner instead of whichever one the host happens to be. Reading the
 * host's dialect is exactly what made these seven red on windows-latest while
 * macOS stayed green — same trap `joinLike` exists for.
 */
const POSIX_DIALECT = hookCliDialect({ platform: "darwin" });
const WINDOWS_DIALECT = hookCliDialect({
	platform: "win32",
	execDir: "C:\\Program Files\\dev3",
	homeDir: "C:\\Users\\dev",
	exists: () => false,
});

/** Every spelling of our handler an older build or the other platform leaves behind. */
const ALL_HOOK_COMMAND_SPELLINGS = [
	codexHookCommand(POSIX_DIALECT),
	`${POSIX_DIALECT.cli} hook codex`,
	codexHookCommand(WINDOWS_DIALECT),
];

describe.each([
	["POSIX", POSIX_DIALECT],
	["Windows", WINDOWS_DIALECT],
])("ensureCodexConfig dev3 hook block on %s (idempotence and self-healing)", (_name, dialect) => {
	const WORKTREES_PATH = "/Users/testuser/.dev3.0/worktrees";
	const SOCKETS_PATH = "/Users/testuser/.dev3.0/sockets";
	const NEW = { codexVersion: "0.147.0", dialect };
	const ensure = (content: string | null) =>
		ensureCodexConfig(content, WORKTREES_PATH, SOCKETS_PATH, [], NEW);
	/** Handlers carrying the `hook codex` subcommand, in any CLI spelling. */
	const dev3Handlers = (config: string) => (config.match(/hook codex/g) ?? []).length;
	const groups = (config: string) => (config.match(/^\[\[hooks\.[A-Za-z]+\]\]$/gm) ?? []).length;
	/** The exact `command = "…"` line this dialect writes, TOML escaping included. */
	const commandLine = (command: string) => `command = ${tomlBasicString(command)}`;
	const ourCommandLine = commandLine(codexHookCommand(dialect));
	const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

	it("declares each status hook exactly once, however often it runs", () => {
		let config = ensure(null);
		for (let i = 0; i < 3; i++) config = ensure(config);
		expect(dev3Handlers(config)).toBe(6);
		expect(groups(config)).toBe(6);
	});

	it("collapses a duplicated block whose opening marker was lost", () => {
		// Exactly the shape found in the wild (h0x91b/dev-3.0#1527): one block that
		// no longer starts with its marker, so the marker-based replace misses it and
		// every launch appends one more copy.
		const orphaned = ensure(null).replace("# >>> dev3 status hooks (generated — do not edit) >>>\n", "");
		expect(dev3Handlers(orphaned)).toBe(6);

		const healed = ensure(orphaned);
		expect(dev3Handlers(healed)).toBe(6);
		expect(groups(healed)).toBe(6);
		expect(ensure(healed)).toBe(healed);
	});

	it("leaves the user's own hooks, and their own hand-written content, alone", () => {
		const userConfig = [
			'model = "gpt-5"',
			"",
			"# my own notification hook — do not touch",
			"[[hooks.Stop]]",
			"",
			"[[hooks.Stop.hooks]]",
			'type = "command"',
			'command = "~/bin/notify-me.sh"',
			"timeout = 5",
			"",
			'[hooks.state."/Users/testuser/.codex/config.toml:stop:0:0"]',
			'trusted_hash = "sha256:abc"',
			"",
		].join("\n");

		const config = ensure(ensure(userConfig));
		expect(config).toContain('command = "~/bin/notify-me.sh"');
		expect(config).toContain("# my own notification hook — do not touch");
		expect(config).toContain('trusted_hash = "sha256:abc"');
		expect(config).toContain('model = "gpt-5"');
		expect(dev3Handlers(config)).toBe(6);
		// Ours plus the user's one Stop group.
		expect(groups(config)).toBe(7);
	});

	it("keeps a mixed group the user glued together, rather than guessing", () => {
		const mixed = [
			'model = "gpt-5"',
			"",
			"[[hooks.Stop]]",
			"",
			"[[hooks.Stop.hooks]]",
			'type = "command"',
			'command = "~/.dev3.0/bin/dev3 hook codex"',
			"",
			"[[hooks.Stop.hooks]]",
			'type = "command"',
			'command = "~/bin/notify-me.sh"',
			"",
		].join("\n");

		const config = ensure(mixed);
		expect(config).toContain('command = "~/bin/notify-me.sh"');
		// The user's group survives untouched, so its dev3 handler is still counted.
		expect(dev3Handlers(config)).toBe(7);
	});

	it("writes the command this platform's hook runner can actually execute", () => {
		const config = ensure(null);
		expect(count(config, ourCommandLine)).toBe(6);

		if (dialect.posixShell) {
			// The env guard is what keeps a foreign Codex session free (#1527).
			expect(config).toContain(
				`command = "sh -c '[ -z \\"$DEV3_TASK_ID\\" ] || exec ~/.dev3.0/bin/dev3 hook codex'"`,
			);
			return;
		}
		// Windows keeps the bare command on purpose: the runner there may be
		// cmd.exe OR PowerShell and no one guard expression is valid in both, so a
		// guard would cost every Windows task its status moves. See
		// decisions/2026/08/25/guard-codex-status-hooks-on-dev3-task-env.md.
		expect(config).toContain(commandLine(`${dialect.cli} hook codex`));
		expect(config).not.toContain("sh -c");
		expect(config).not.toContain("DEV3_TASK_ID");
	});

	it("leaves alone a hook the user wrote themselves that calls the dev3 CLI", () => {
		// Calling `dev3` is not what makes a group ours — the `hook codex`
		// subcommand is. A user's own board automation must survive every launch.
		const own = [
			"[[hooks.Notification]]",
			"",
			"[[hooks.Notification.hooks]]",
			'type = "command"',
			'command = "~/.dev3.0/bin/dev3 task move --status in-progress"',
			"",
			"[[hooks.Stop]]",
			"",
			"[[hooks.Stop.hooks]]",
			'type = "command"',
			'command = "~/.dev3.0/bin/dev3 note add mine"',
			"",
		].join("\n");

		const config = ensure(ensure(own));
		expect(config).toContain('command = "~/.dev3.0/bin/dev3 task move --status in-progress"');
		expect(config).toContain('command = "~/.dev3.0/bin/dev3 note add mine"');
		expect(dev3Handlers(config)).toBe(6);
		// Ours plus the user's two groups.
		expect(groups(config)).toBe(8);
	});

	it("still collects an orphan left by an older build, or by the other platform", () => {
		const orphaned = ensure(null).replace("# >>> dev3 status hooks (generated — do not edit) >>>\n", "");

		for (const spelling of ALL_HOOK_COMMAND_SPELLINGS) {
			// Re-spell the orphan the way the other platform, or an older build,
			// would have written it — then heal it with THIS dialect.
			const foreign = orphaned.replaceAll(ourCommandLine, commandLine(spelling));
			const healed = ensure(foreign);
			expect(dev3Handlers(healed)).toBe(6);
			expect(groups(healed)).toBe(6);
			// Nothing but the freshly written block is left.
			expect((healed.match(/^command = /gm) ?? []).length).toBe(6);
			expect(count(healed, ourCommandLine)).toBe(6);
		}
	});
});
