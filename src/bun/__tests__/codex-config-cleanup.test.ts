import { describe, it, expect } from "vitest";
import { ensureCodexConfig } from "../codex-config";

describe("legacy section cleanup via ensureCodexConfig", () => {
	const WORKTREES_PATH = "/Users/testuser/.dev3.0/worktrees";
	const SOCKETS_PATH = "/Users/testuser/.dev3.0/sockets";

	describe("old [permissions.network] cleanup", () => {
		it("removes old-style [permissions.network] with dev3 sockets", () => {
			const existing = `model = "gpt-5.4"

[permissions.network]
enabled = true
allow_unix_sockets = ["${SOCKETS_PATH}"]

[projects."/Users/testuser/my-project"]
trust_level = "trusted"
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).not.toMatch(/^\[permissions\.network\]$/m);
			expect(result).toContain("[permissions.dev3.network]");
			expect(result).toContain('[projects."/Users/testuser/my-project"]');
		});

		it("does not touch [permissions.network] without dev3 socket path", () => {
			const config = `model = "gpt-5.4"

[permissions.network]
enabled = true
allow_unix_sockets = ["/tmp/my-own.sock"]
`;
			const result = ensureCodexConfig(config, WORKTREES_PATH, SOCKETS_PATH);
			expect(result).toContain("[permissions.network]");
			expect(result).toContain('allow_unix_sockets = ["/tmp/my-own.sock"]');
		});
	});

	describe("preserves user's [permissions.workspace.*] sections", () => {
		it("does not touch workspace sections even when dev3 profile exists alongside", () => {
			const existing = `default_permissions = "workspace"

[permissions.workspace.filesystem]
":minimal" = "read"

[permissions.workspace.filesystem.":project_roots"]
"." = "write"

[permissions.workspace.network]
enabled = true
allow_unix_sockets = ["${SOCKETS_PATH}"]

[permissions.dev3.filesystem]
":minimal" = "read"
"~/.codex/skills" = "read"
"~/.agents/skills" = "read"

[permissions.dev3.network]
enabled = true
allow_unix_sockets = ["${SOCKETS_PATH}"]
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			// User's workspace sections must remain untouched
			expect(result).toContain("[permissions.workspace.filesystem]");
			expect(result).toContain("[permissions.workspace.network]");
			// dev3 sections still present
			expect(result).toContain("[permissions.dev3.network]");
			expect(result).toContain('default_permissions = "workspace"');
		});
	});

	describe("real-world migration", () => {
		it("handles full real-world config with old [permissions.network]", () => {
			const existing = `model = "gpt-5.4"
model_reasoning_effort = "medium"
personality = "pragmatic"

[projects."/Users/testuser/Desktop/src/ASTRA"]
trust_level = "trusted"
sandbox_mode = "workspace-write"

[profiles.ro]
sandbox_mode = "read-only"

[profiles.rw]
sandbox_mode = "workspace-write"

[notice]
hide_gpt5_1_migration_prompt = true

[mcp_servers.playwright]
command = "npx"
args = ["@playwright/mcp@latest"]

# [mcp_servers.vibe_kanban]
# command = "npx"

[permissions.network]
allow_unix_sockets = ["${SOCKETS_PATH}"]
enabled = true

[projects."${WORKTREES_PATH}"]
trust_level = "trusted"
`;
			const result = ensureCodexConfig(existing, WORKTREES_PATH, SOCKETS_PATH);
			// Old section removed
			expect(result).not.toMatch(/^\[permissions\.network\]$/m);
			// New dev3 profile added
			expect(result).toContain("[permissions.dev3.network]");
			expect(result).toContain("[profiles.dev3]");
			// Everything else preserved
			expect(result).toContain('model = "gpt-5.4"');
			expect(result).toContain("[profiles.ro]");
			expect(result).toContain("[profiles.rw]");
			expect(result).toContain("[notice]");
			expect(result).toContain("[mcp_servers.playwright]");
			expect(result).toContain("# [mcp_servers.vibe_kanban]");
		});
	});
});
