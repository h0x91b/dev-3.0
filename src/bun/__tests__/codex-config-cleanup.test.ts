import { describe, it, expect } from "vitest";
import { ensureCodexConfig } from "../codex-config";

describe("old [permissions.network] cleanup via ensureCodexConfig", () => {
	const WORKTREES_PATH = "/Users/testuser/.dev3.0/worktrees";
	const SOCKETS_PATH = "/Users/testuser/.dev3.0/sockets";

	// Real-world config taken from a user's ~/.codex/config.toml
	// with old dev3-injected [permissions.network] section at the end.
	const REAL_CONFIG = `model = "gpt-5.4"
model_reasoning_effort = "medium"
personality = "pragmatic"

[projects."/Users/testuser/Desktop/src/ASTRA"]
trust_level = "trusted"
sandbox_mode = "workspace-write"

[projects."/Users/testuser/Desktop/src-shared/moto-drag"]
trust_level = "trusted"

[projects."/Users/testuser/Desktop/src-shared/dev-3.0"]
trust_level = "trusted"

[profiles.ro]
sandbox_mode = "read-only"

[profiles.rw]
sandbox_mode = "workspace-write"

[notice]
hide_gpt5_1_migration_prompt = true
"hide_gpt-5.1-codex-max_migration_prompt" = true

[notice.model_migrations]
"gpt-5.2" = "gpt-5.2-codex"
"gpt-5.2-codex" = "gpt-5.3-codex"

[mcp_servers.playwright]
command = "npx"
args = ["@playwright/mcp@latest"]

# [mcp_servers.vibe_kanban]
# command = "npx"
# args = ["-y", "vibe-kanban@latest", "--mcp"]

[permissions.network]
allow_unix_sockets = ["/Users/testuser/.dev3.0/sockets"]
enabled = true

[projects."/Users/testuser/.dev3.0/worktrees"]
trust_level = "trusted"
`;

	it("removes old [permissions.network] and adds new [permissions.workspace.network]", () => {
		const result = ensureCodexConfig(REAL_CONFIG, WORKTREES_PATH, SOCKETS_PATH);
		expect(result).not.toMatch(/^\[permissions\.network\]$/m);
		expect(result).toContain("[permissions.workspace.network]");
		expect(result).toContain("enabled = true");
		expect(result).toContain(`allow_unix_sockets = ["${SOCKETS_PATH}"]`);
	});

	it("preserves all other sections in real-world config", () => {
		const result = ensureCodexConfig(REAL_CONFIG, WORKTREES_PATH, SOCKETS_PATH);
		expect(result).toContain('model = "gpt-5.4"');
		expect(result).toContain('model_reasoning_effort = "medium"');
		expect(result).toContain('personality = "pragmatic"');
		expect(result).toContain('[projects."/Users/testuser/Desktop/src/ASTRA"]');
		expect(result).toContain('sandbox_mode = "workspace-write"');
		expect(result).toContain('[projects."/Users/testuser/Desktop/src-shared/moto-drag"]');
		expect(result).toContain('[projects."/Users/testuser/Desktop/src-shared/dev-3.0"]');
		expect(result).toContain("[profiles.ro]");
		expect(result).toContain("[profiles.rw]");
		expect(result).toContain("[notice]");
		expect(result).toContain("[notice.model_migrations]");
		expect(result).toContain("[mcp_servers.playwright]");
		expect(result).toContain('args = ["@playwright/mcp@latest"]');
		expect(result).toContain("# [mcp_servers.vibe_kanban]");
		expect(result).toContain('[projects."/Users/testuser/.dev3.0/worktrees"]');
	});

	it("adds default_permissions = workspace when migrating from old config", () => {
		const result = ensureCodexConfig(REAL_CONFIG, WORKTREES_PATH, SOCKETS_PATH);
		expect(result).toContain('default_permissions = "workspace"');
	});

	it("removes old [permissions.network] when it is the only section", () => {
		const config = `[permissions.network]
enabled = true
allow_unix_sockets = ["/Users/testuser/.dev3.0/sockets"]
`;
		const result = ensureCodexConfig(config, WORKTREES_PATH, SOCKETS_PATH);
		expect(result).not.toMatch(/^\[permissions\.network\]$/m);
		expect(result).toContain("[permissions.workspace.network]");
	});

	it("removes old [permissions.network] from the middle of the file", () => {
		const config = `model = "gpt-5.4"

[permissions.network]
enabled = true
allow_unix_sockets = ["/Users/testuser/.dev3.0/sockets"]

[projects."/Users/testuser/my-project"]
trust_level = "trusted"
`;
		const result = ensureCodexConfig(config, WORKTREES_PATH, SOCKETS_PATH);
		expect(result).not.toMatch(/^\[permissions\.network\]$/m);
		expect(result).toContain('model = "gpt-5.4"');
		expect(result).toContain('[projects."/Users/testuser/my-project"]');
		expect(result).toContain("[permissions.workspace.network]");
	});

	it("does not touch [permissions.network] without dev3 socket path", () => {
		const config = `model = "gpt-5.4"

[permissions.network]
enabled = true
allow_unix_sockets = ["/tmp/my-own.sock"]

[projects."/Users/testuser/my-project"]
trust_level = "trusted"
`;
		const result = ensureCodexConfig(config, WORKTREES_PATH, SOCKETS_PATH);
		// Old section without dev3 sockets is preserved
		expect(result).toContain("[permissions.network]");
		expect(result).toContain('allow_unix_sockets = ["/tmp/my-own.sock"]');
	});

	it("handles old [permissions.network] with extra keys", () => {
		const config = `model = "gpt-5.4"

[permissions.network]
enabled = true
allow_unix_sockets = ["/Users/testuser/.dev3.0/sockets"]
some_other_key = "value"

[projects."/Users/testuser/my-project"]
trust_level = "trusted"
`;
		const result = ensureCodexConfig(config, WORKTREES_PATH, SOCKETS_PATH);
		expect(result).not.toMatch(/^\[permissions\.network\]$/m);
		expect(result).not.toContain("some_other_key");
		expect(result).toContain('[projects."/Users/testuser/my-project"]');
		expect(result).toContain("[permissions.workspace.network]");
	});
});
