import { describe, it, expect } from "vitest";
import { load } from "js-toml";
import {
	ensureCodexConfig,
	codexServersWithTransport,
	ensureCodexProfileFile,
	getCodexSyntaxForVersion,
	hasNarrowedWorkspaceProfile,
	pruneOrphanedMcpServers,
	pickCodexProfileLaunchFlag,
	tomlBasicString,
} from "../codex-config";
import { codexHookCommand } from "../../shared/agent-hooks";
import { parseCliVersion } from "../../shared/agent-model-cli-requirements";
import { hookCliDialect } from "../../shared/dev3-cli-path";

describe("ensureCodexConfig", () => {
	const WORKTREES_PATH = "/Users/testuser/.dev3.0/worktrees";
	const SOCKETS_PATH = "/Users/testuser/.dev3.0/sockets";

	describe("when config does not exist", () => {
		it("creates trust, workspace default permissions, permissions.dev3 and dev3 profiles without narrowing non-dev3 Codex", () => {
			const worktreePath = "/Users/testuser/.dev3.0/worktrees/proj/abcd1234/worktree";
			const result = ensureCodexConfig(null, WORKTREES_PATH, SOCKETS_PATH, [worktreePath]);
			expect(result).toContain(`[projects."${WORKTREES_PATH}"]`);
			expect(result).toContain(`[projects."${worktreePath}"]`);
			expect(result).toContain('trust_level = "trusted"');
			expect(result).toContain('default_permissions = "workspace"');
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
			// The generic workspace profile stays as wide as Codex's own default.
			const workspaceFs = result.slice(result.indexOf("[permissions.workspace.filesystem]"));
			const workspaceFsBlock = workspaceFs.slice(0, workspaceFs.indexOf("\n["));
			expect(workspaceFsBlock).toContain('":root" = "read"');
			expect(workspaceFsBlock).not.toContain('":minimal"');
		});
	});

	describe("Codex version compatibility", () => {
		describe("pickCodexProfileLaunchFlag (issue #611)", () => {
			it("prefers --profile-v2 only when the help text really lists it", () => {
				const both = [
					"Options:",
					"  -p, --profile <CONFIG_PROFILE>      Configuration profile",
					"      --profile-v2 <CONFIG_PROFILE_V2>  File-based profile",
				].join("\n");
				expect(pickCodexProfileLaunchFlag(both)).toBe("--profile-v2");
				// --profile-v2 removed after the rename
				expect(pickCodexProfileLaunchFlag("  -p, --profile <CONFIG_PROFILE_V2>  Configuration profile")).toBe("--profile");
				// legacy help, substring lookalike, empty help
				expect(pickCodexProfileLaunchFlag("  -p, --profile <CONFIG_PROFILE>  Configuration profile to use")).toBe("--profile");
				expect(pickCodexProfileLaunchFlag("  --profile-v2-foo <X>  unrelated flag")).toBe("--profile");
				expect(pickCodexProfileLaunchFlag("")).toBe("--profile");
			});
		});

		it("parses the CLI version and maps it to the right config syntax", () => {
			expect(parseCliVersion("codex-cli 0.133.0")).toEqual({ major: 0, minor: 133, patch: 0 });
			expect(parseCliVersion("OpenAI Codex (v0.131.2)")).toEqual({ major: 0, minor: 131, patch: 2 });
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
			// The unix-socket allowlist switches to map form at 0.119.
			expect(getCodexSyntaxForVersion("codex-cli 0.118.9").unixSocketsAsMap).toBe(false);
			expect(getCodexSyntaxForVersion("codex-cli 0.119.0").unixSocketsAsMap).toBe(true);
			expect(getCodexSyntaxForVersion(null).unixSocketsAsMap).toBe(false);
		});

		it("writes the root key and the one hooks flag the Codex version expects (0.131+ vs 0.129-0.130)", () => {
			const newer = ensureCodexConfig(null, WORKTREES_PATH, SOCKETS_PATH, [], { codexVersion: "codex-cli 0.133.0" });
			expect(newer).toContain('[permissions.workspace.filesystem.":workspace_roots"]');
			expect(newer).toContain('[permissions.dev3.filesystem.":workspace_roots"]');
			expect(newer).toContain("hooks = true");
			expect(newer).not.toContain(":project_roots");
			expect(newer).not.toMatch(/^codex_hooks\s*=/m);

			const mid = ensureCodexConfig(null, WORKTREES_PATH, SOCKETS_PATH, [], { codexVersion: "codex-cli 0.130.0" });
			expect(mid).toContain('[permissions.workspace.filesystem.":project_roots"]');
			expect(mid).toContain('[permissions.dev3.filesystem.":project_roots"]');
			expect(mid).toContain("hooks = true");
			expect(mid).not.toContain(":workspace_roots");
			expect(mid).not.toMatch(/^codex_hooks\s*=/m);
			{
			const newer = ensureCodexConfig("[features]\n  codex_hooks = true\nhooks = true\njs_repl = false\n", WORKTREES_PATH, SOCKETS_PATH, [], {
				codexVersion: "codex-cli 0.133.0",
			});
			expect(newer).toContain("js_repl = false");
			expect(newer).not.toContain("codex_hooks");
			expect(newer.match(/^[ \t]*hooks\s*=/gm)).toHaveLength(1);

			const older = ensureCodexConfig("[features]\n  hooks = true\ncodex_hooks = true\njs_repl = false\n", WORKTREES_PATH, SOCKETS_PATH, [], {
				codexVersion: "codex-cli 0.128.0",
			});
			expect(older).toContain("js_repl = false");
			expect(older).not.toMatch(/^[ \t]*hooks\s*=/m);
			expect(older.match(/^[ \t]*codex_hooks\s*=/gm)).toHaveLength(1);
			}
		});

		it("migrates managed keys to the syntax of the running Codex, in both directions", () => {
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
			{
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
			}
		});

	});

	describe("when config exists with user settings", () => {
		it("preserves the user's own settings, projects and comments while adding dev3 entries", () => {
			const existing = `# My codex config
model = "gpt-5.4"
default_permissions = "workspace"

[projects."/Users/testuser/my-project"]
trust_level = "trusted"
sandbox_mode = "workspace-write"

# MCP servers
[mcp_servers.playwright]
command = "npx"
args = ["@playwright/mcp@latest"]

# Disabled for now
# [mcp_servers.vibe_kanban]
# command = "npx"
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain('default_permissions = "workspace"');
			expect(result).toContain('[projects."/Users/testuser/my-project"]');
			expect(result).toContain('sandbox_mode = "workspace-write"');
			expect(result).toContain(`[projects."${WORKTREES_PATH}"]`);
			expect(result).toContain("[permissions.dev3.network]");
			expect(result).toContain("[profiles.dev3]");
			expect(result).toContain("# My codex config");
			expect(result).toContain("# MCP servers");
			expect(result).toContain("# Disabled for now");
		});

		it("adds default_permissions = workspace, filling the workspace profile first, when it is missing", () => {
			const existing = `model = "gpt-5.4"

[permissions.dev3.filesystem]
":minimal" = "read"

[permissions.dev3.network]
enabled = true
allow_unix_sockets = ["${SOCKETS_PATH}"]
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain('default_permissions = "workspace"');
			expect(result).toContain("[permissions.workspace.filesystem]");
			expect(result).toContain("[permissions.workspace.network]");
			{
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
			}
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
		it("forces codex_hooks = true without removing other feature flags", () => {
			const result = ensureCodexConfig("[features]\nexperimental_resume = true\ncodex_hooks = false\n", WORKTREES_PATH, SOCKETS_PATH);
			expect(result.match(/\[features\]/g)).toHaveLength(1);
			expect(result).toContain("experimental_resume = true");
			expect(result).toContain("codex_hooks = true");
			expect(result).not.toContain("codex_hooks = false");
		});
	});

	describe("when the dev3 permission profile is incomplete", () => {
		it("adds the socket, skill directory reads and dev3 data write access", () => {
			const existing = `[permissions.dev3.filesystem]
":minimal" = "read"

[permissions.dev3.filesystem.":project_roots"]
"." = "write"

[permissions.dev3.network]
enabled = true
allow_unix_sockets = ["/tmp/other.sock"]
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain(`allow_unix_sockets = ["/tmp/other.sock", "${SOCKETS_PATH}"]`);
			expect(result).toContain('"/Users/testuser/.codex/skills" = "read"');
			expect(result).toContain('"/Users/testuser/.agents/skills" = "read"');
			expect(result).toContain('"/Users/testuser/.dev3.0" = "write"');
		});
	});

	describe("handles edge cases", () => {
		it("handles empty, whitespace-only and newline-less configs, and returns unparseable config unchanged", () => {
			for (const input of ["", "  \n\n  "]) {
				const result = ensureCodexConfig(input, WORKTREES_PATH, SOCKETS_PATH);
				expect(result, JSON.stringify(input)).toContain(`[projects."${WORKTREES_PATH}"]`);
				expect(result, JSON.stringify(input)).toContain("[profiles.dev3-dark]");
			}
			const noNewline = ensureCodexConfig('model = "gpt-5.4"', WORKTREES_PATH, SOCKETS_PATH);
			expect(noNewline).toContain('model = "gpt-5.4"');
			expect(noNewline).toContain(`[projects."${WORKTREES_PATH}"]`);
			{
			const broken = "this is not valid toml [[[";
			const result = ensureCodexConfig(broken, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toBe(broken);
			}
		});

	});

	describe("profile-v2 (Codex ≥0.134)", () => {
		it("emits [profiles.dev3*] in the main config only below 0.134", () => {
			const v2 = ensureCodexConfig(null, WORKTREES_PATH, SOCKETS_PATH, [], { codexVersion: "codex-cli 0.134.0" });
			expect(v2).not.toMatch(/^\[profiles\.dev3(-light|-dark)?\]/m);
			// Permissions and trust still patched
			expect(v2).toContain("[permissions.dev3.network]");
			expect(v2).toContain(`[projects."${WORKTREES_PATH}"]`);

			const legacy = ensureCodexConfig(null, WORKTREES_PATH, SOCKETS_PATH, [], { codexVersion: "codex-cli 0.130.0" });
			expect(legacy).toContain("[profiles.dev3]");
			expect(legacy).toContain("[profiles.dev3-light]");
			expect(legacy).toContain("[profiles.dev3-dark]");
		});

		it("removes managed profile tables (nested ones too) and a dev3 top-level selector on v2, preserving the user's", () => {
			const existing = `model = "gpt-5.4"

[profiles.dev3]
web_search = "live"

[profiles.dev3-light]
web_search = "live"
# tui.theme = "github"

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
			expect(result).not.toMatch(/^\[profiles\.dev3(-light|-dark)?\]/m);
			expect(result).not.toContain("[profiles.dev3-dark.tui]");
			expect(result).not.toContain("[profiles.dev3-light.tui]");
			expect(result).toContain("[profiles.dev3-dark-custom]");
			expect(result).toContain("[profiles.ro]");
			expect(result).toContain('sandbox_mode = "read-only"');
			{
			const existing = `model = "gpt-5.4"
profile = "dev3-light"

[projects."/Users/testuser/app"]
trust_level = "trusted"
`;
			const v2 = { codexVersion: "codex-cli 0.134.0" };
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH, [], v2);
			expect(result).not.toMatch(/^profile\s*=\s*"dev3-light"/m);
			expect(result).toContain('model = "gpt-5.4"');
			expect(result).toContain('[projects."/Users/testuser/app"]');
			expect(ensureCodexConfig('profile = "my-custom"\n', WORKTREES_PATH, SOCKETS_PATH, [], v2)).toContain('profile = "my-custom"');
			}
		});

	});

	describe("ensureCodexProfileFile", () => {
		it("creates the file, preserves unrelated content and upserts rather than duplicates", () => {
			const fresh = ensureCodexProfileFile(null, { web_search: '"live"' });
			expect(fresh).toContain('web_search = "live"');
			expect(fresh.endsWith("\n")).toBe(true);

			const existing = `model = "gpt-5.4"
sandbox_mode = "workspace-write"
web_search = "disabled"
`;
			const result = ensureCodexProfileFile(existing, { web_search: '"live"' });
			expect(result).toContain('model = "gpt-5.4"');
			expect(result).toContain('sandbox_mode = "workspace-write"');
			expect(result.match(/^web_search\s*=/gm)).toHaveLength(1);
			expect(result).toContain('web_search = "live"');
		});

		it("drops an orphaned approval table that would break the launch (issue #1640), keeping one whose server the main config defines", () => {
			const existing = `web_search = "live"

[mcp_servers."mcp-s".tools.search]
approval_mode = "approve"
`;
			const result = ensureCodexProfileFile(existing, { web_search: '"live"' });
			expect(result).not.toContain("mcp_servers");
			expect(result).toContain('web_search = "live"');
			{
			const existing = `[mcp_servers.mcp-s.tools.search]
approval_mode = "approve"
`;
			const result = ensureCodexProfileFile(existing, {}, new Set(["mcp-s"]));
			expect(result).toContain("[mcp_servers.mcp-s.tools.search]");
			}
		});

	});

	describe("pruneOrphanedMcpServers", () => {
		it("prunes only a server that carries no transport, leaving neighbours untouched", () => {
			const content = `[mcp_servers.x]
enabled = true

[mcp_servers.x.tools.t]
approval_mode = "approve"
`;
			expect(pruneOrphanedMcpServers(content)).not.toContain("mcp_servers");
			{
			const content = `model = "gpt-5.4"

[mcp_servers.good]
command = "echo"

[mcp_servers.gone.tools.t]
approval_mode = "approve"

[tui]
theme = "dark"
`;
			const result = pruneOrphanedMcpServers(content);
			expect(result).toContain("[mcp_servers.good]");
			expect(result).not.toContain("gone");
			expect(result).toContain('model = "gpt-5.4"');
			expect(result).toContain("[tui]");
			}
		});

		it("leaves stdio and url servers, and unparsable content, unchanged", () => {
			const stdio = `[mcp_servers.x]
command = "echo"

[mcp_servers.x.tools.t]
approval_mode = "approve"
`;
			const http = `[mcp_servers.x]
url = "https://example.com/mcp"
`;
			const broken = "this is = = not toml\n";
			for (const content of [stdio, http, broken]) expect(pruneOrphanedMcpServers(content)).toBe(content);
		});

	});

	describe("codexServersWithTransport", () => {
		it("reports only servers that declare a transport, and nothing for null or unparsable content", () => {
			const content = `[mcp_servers.a]
command = "echo"

[mcp_servers.b]
url = "https://example.com/mcp"

[mcp_servers.c.tools.t]
approval_mode = "approve"
`;
			expect([...codexServersWithTransport(content)].sort()).toEqual(["a", "b"]);
			expect(codexServersWithTransport(null).size).toBe(0);
			expect(codexServersWithTransport("= =\n").size).toBe(0);
		});
	});
});

describe("ensureCodexConfig unix-socket allowlist (codex >= 0.119 map form)", () => {
	const WORKTREES_PATH = "/Users/testuser/.dev3.0/worktrees";
	const SOCKETS_PATH = "/Users/testuser/.dev3.0/sockets";
	const NEW = { codexVersion: "0.141.0" };
	const count = (hay: string, needle: string) => hay.split(needle).length - 1;

	it("writes the unix_sockets map (not the legacy array) on a fresh config, idempotently", () => {
		const result = ensureCodexConfig(null, WORKTREES_PATH, SOCKETS_PATH, [], NEW);
		expect(result).toContain("[permissions.dev3.network]");
		expect(result).toContain("enabled = true");
		expect(result).toContain("[permissions.dev3.network.unix_sockets]");
		expect(result).toContain(`"${SOCKETS_PATH}" = "allow"`);
		expect(result).not.toContain("allow_unix_sockets");
		{
		const once = ensureCodexConfig(null, WORKTREES_PATH, SOCKETS_PATH, [], NEW);
		const twice = ensureCodexConfig(once, WORKTREES_PATH, SOCKETS_PATH, [], NEW);
		expect(count(twice, "[permissions.dev3.network.unix_sockets]")).toBe(1);
		expect(count(twice, `"${SOCKETS_PATH}" = "allow"`)).toBe(1);
		expect(twice).not.toContain("allow_unix_sockets");
		}
	});

	it("keeps the legacy array form below 0.119 and when the codex version is unknown", () => {
		for (const opts of [{ codexVersion: "0.118.0" }, undefined]) {
			const result = ensureCodexConfig(null, WORKTREES_PATH, SOCKETS_PATH, [], opts);
			expect(result, String(opts?.codexVersion)).toContain(`allow_unix_sockets = ["${SOCKETS_PATH}"]`);
			expect(result, String(opts?.codexVersion)).not.toContain("[permissions.dev3.network.unix_sockets]");
		}
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

	it("keeps foreign sockets from a legacy array or an existing map and adds ours once", () => {
		const fromArray = ensureCodexConfig(`[permissions.dev3.network]
enabled = true
allow_unix_sockets = ["/tmp/other.sock"]
`, WORKTREES_PATH, SOCKETS_PATH, [], NEW);
		expect(fromArray).not.toContain("allow_unix_sockets =");
		expect(fromArray).toContain(`"${SOCKETS_PATH}" = "allow"`);
		expect(fromArray).toContain('"/tmp/other.sock" = "allow"');

		const fromMap = ensureCodexConfig(`[permissions.dev3.network]
enabled = true

[permissions.dev3.network.unix_sockets]
"/tmp/other.sock" = "allow"
`, WORKTREES_PATH, SOCKETS_PATH, [], NEW);
		expect(fromMap).toContain('"/tmp/other.sock" = "allow"');
		expect(fromMap).toContain(`"${SOCKETS_PATH}" = "allow"`);
		expect(count(fromMap, "[permissions.dev3.network.unix_sockets]")).toBe(1);
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

	it("declares each status hook exactly once however often it runs, collapsing a block whose opening marker was lost", () => {
		let config = ensure(null);
		for (let i = 0; i < 3; i++) config = ensure(config);
		expect(dev3Handlers(config)).toBe(8);
		expect(groups(config)).toBe(8);
		{
		// Exactly the shape found in the wild (h0x91b/dev-3.0#1527): one block that
		// no longer starts with its marker, so the marker-based replace misses it and
		// every launch appends one more copy.
		const orphaned = ensure(null).replace("# >>> dev3 status hooks (generated — do not edit) >>>\n", "");
		expect(dev3Handlers(orphaned)).toBe(8);

		const healed = ensure(orphaned);
		expect(dev3Handlers(healed)).toBe(8);
		expect(groups(healed)).toBe(8);
		expect(ensure(healed)).toBe(healed);
		}
	});

	it("leaves the user's own hooks — even ones calling the dev3 CLI, or glued into a mixed group — and their content alone", () => {
		// Calling `dev3` is not what makes a group ours — the `hook codex`
		// subcommand is. A user's own board automation must survive every launch.
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
			"[[hooks.Notification]]",
			"",
			"[[hooks.Notification.hooks]]",
			'type = "command"',
			'command = "~/.dev3.0/bin/dev3 task move --status in-progress"',
			"",
			'[hooks.state."/Users/testuser/.codex/config.toml:stop:0:0"]',
			'trusted_hash = "sha256:abc"',
			"",
		].join("\n");

		const config = ensure(ensure(userConfig));
		expect(config).toContain('command = "~/bin/notify-me.sh"');
		expect(config).toContain('command = "~/.dev3.0/bin/dev3 task move --status in-progress"');
		expect(config).toContain("# my own notification hook — do not touch");
		expect(config).toContain('trusted_hash = "sha256:abc"');
		expect(config).toContain('model = "gpt-5"');
		expect(dev3Handlers(config)).toBe(8);
		// Ours plus the user's two groups.
		expect(groups(config)).toBe(10);
		{
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
		expect(dev3Handlers(config)).toBe(9);
		}
	});

	it("writes the command this platform's hook runner can actually execute", () => {
		const config = ensure(null);
		expect(count(config, ourCommandLine)).toBe(8);

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

	it("still collects an orphan left by an older build, or by the other platform", () => {
		const orphaned = ensure(null).replace("# >>> dev3 status hooks (generated — do not edit) >>>\n", "");

		for (const spelling of ALL_HOOK_COMMAND_SPELLINGS) {
			// Re-spell the orphan the way the other platform, or an older build,
			// would have written it — then heal it with THIS dialect.
			const foreign = orphaned.replaceAll(ourCommandLine, commandLine(spelling));
			const healed = ensure(foreign);
			expect(dev3Handlers(healed)).toBe(8);
			expect(groups(healed)).toBe(8);
			// Nothing but the freshly written block is left.
			expect((healed.match(/^command = /gm) ?? []).length).toBe(8);
			expect(count(healed, ourCommandLine)).toBe(8);
		}
	});
});

// ── [tui] whimsy — Codex's Astra composer stars ──────────────────────────────
//
// The stars repaint behind the input every 150ms for as long as the composer is
// visible, so an idle pane streams ~187 KB every 20 seconds for decoration. dev3
// seeds the quiet default, and must never overrule a user who wants them back.

describe("ensureCodexConfig — [tui] whimsy", () => {
	const WORKTREES_PATH = "/Users/testuser/.dev3.0/worktrees";
	const SOCKETS_PATH = "/Users/testuser/.dev3.0/sockets";
	const ensure = (content: string | null) =>
		ensureCodexConfig(content, WORKTREES_PATH, SOCKETS_PATH);

	it("seeds whimsy = false into a fresh config idempotently, never rewriting an explicit choice", () => {
		const once = ensure(null);
		expect(once).toContain("whimsy = false");
		const twice = ensure(once);
		expect((twice.match(/^whimsy = /gm) ?? []).length).toBe(1);
		expect((twice.match(/^\[tui\]$/gm) ?? []).length).toBe(1);
		{
		const on = ensure("[tui]\nwhimsy = true\n");
		expect(on).toContain("whimsy = true");
		expect(on).not.toContain("whimsy = false");
		expect((ensure("[tui]\nwhimsy = false\n").match(/^whimsy = /gm) ?? []).length).toBe(1);
		}
	});

	it("adds whimsy to a [tui] section the user already has, keeping their keys and a parseable config", () => {
		const existing = `model = "gpt-6-astra"

[tui]
theme = "github"
status_line = ["git-branch"]
`;
		const config = ensure(existing);
		expect(config).toContain('status_line = ["git-branch"]');
		// One [tui] section, not a second one appended below.
		expect((config.match(/^\[tui\]$/gm) ?? []).length).toBe(1);
		const parsed = load(config) as { tui?: Record<string, unknown> };
		expect(parsed.tui?.whimsy).toBe(false);
		expect(parsed.tui?.theme).toBe("github");
	});

});

// ---------------------------------------------------------------------------
// An older dev3 wrote `default_permissions = "workspace"` with `":minimal" =
// "read"` into the user's global Codex config. That profile is narrower than
// Codex's own default and, on a Homebrew install, stops standalone Codex from
// starting a session at all. dev3 put it there, so dev3 takes it back out on
// the next launch — the fingerprint is exact, and a profile carrying anything
// else belongs to the user and is never touched.
// ---------------------------------------------------------------------------

const NARROWED = `default_permissions = "workspace"

[permissions.workspace.filesystem]
":minimal" = "read"

[permissions.workspace.filesystem.":workspace_roots"]
"." = "write"

[permissions.workspace.network]
enabled = true
`;

describe("repairing the profile an older dev3 narrowed", () => {
	const WORKTREES_PATH = "/Users/testuser/.dev3.0/worktrees";
	const SOCKETS_PATH = "/Users/testuser/.dev3.0/sockets";
	const patch = (config: string) => ensureCodexConfig(config, WORKTREES_PATH, SOCKETS_PATH, [], { codexVersion: "codex-cli 0.154.0" });

	it("widens only the exact profile dev3 wrote, keeps the rest, and is a no-op on the next launch", () => {
		const once = patch(NARROWED);
		expect(once).toContain('":root" = "read"');
		expect(once).toContain('[permissions.workspace.filesystem.":workspace_roots"]');
		expect(once).toContain("enabled = true");
		expect(once).toContain('default_permissions = "workspace"');
		expect(patch(once)).toBe(once);
		{
		const handWritten = NARROWED.replace('":minimal" = "read"', '":minimal" = "read"\n"/Users/testuser/notes" = "read"');
		const result = patch(handWritten);
		expect(result).not.toContain('":root" = "read"');
		expect(result).toContain('"/Users/testuser/notes" = "read"');
		const elsewhere = NARROWED.replace('default_permissions = "workspace"', 'default_permissions = "mine"');
		expect(patch(elsewhere)).not.toContain('":root" = "read"');
		}
	});

});

describe("hasNarrowedWorkspaceProfile", () => {
	const parse = (config: string) => load(config) as Parameters<typeof hasNarrowedWorkspaceProfile>[0];

	it("recognizes only the exact profile an older dev3 wrote", () => {
		expect(hasNarrowedWorkspaceProfile(parse(NARROWED))).toBe(true);
		expect(hasNarrowedWorkspaceProfile(parse(NARROWED.replace('":minimal"', '":root"')))).toBe(false);
		expect(hasNarrowedWorkspaceProfile({})).toBe(false);
	});
});
