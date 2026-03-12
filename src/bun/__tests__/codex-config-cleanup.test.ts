import { describe, it, expect } from "vitest";
import { cleanupCodexConfig } from "../codex-config";

describe("cleanupCodexConfig", () => {
	// Real-world config taken from a user's ~/.codex/config.toml
	// with dev3-injected [permissions.network] section at the end.
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

	it("removes [permissions.network] section from real-world config", () => {
		const result = cleanupCodexConfig(REAL_CONFIG);
		expect(result).not.toContain("[permissions.network]");
		expect(result).not.toContain("allow_unix_sockets");
		expect(result).not.toContain("enabled = true");
	});

	it("preserves all other sections in real-world config", () => {
		const result = cleanupCodexConfig(REAL_CONFIG);
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
		// Commented-out sections should remain
		expect(result).toContain("# [mcp_servers.vibe_kanban]");
		// The worktrees project entry should remain (it's harmless, just trusts the path)
		expect(result).toContain('[projects."/Users/testuser/.dev3.0/worktrees"]');
	});

	it("does not leave trailing blank lines where the section was removed", () => {
		const result = cleanupCodexConfig(REAL_CONFIG);
		// Should not have 3+ consecutive blank lines
		expect(result).not.toMatch(/\n{4,}/);
	});

	it("returns unchanged config when there is no [permissions.network] section", () => {
		const clean = `model = "gpt-5.4"

[projects."/Users/testuser/my-project"]
trust_level = "trusted"
`;
		const result = cleanupCodexConfig(clean);
		expect(result).toBe(clean);
	});

	it("returns unchanged config when content is null", () => {
		expect(cleanupCodexConfig(null)).toBeNull();
	});

	it("returns unchanged config when content is empty", () => {
		expect(cleanupCodexConfig("")).toBe("");
	});

	it("removes [permissions.network] when it is the only section", () => {
		const config = `[permissions.network]
enabled = true
allow_unix_sockets = ["/Users/testuser/.dev3.0/sockets"]
`;
		const result = cleanupCodexConfig(config);
		expect(result).not.toContain("[permissions.network]");
		expect(result).not.toContain("allow_unix_sockets");
		expect(result!.trim()).toBe("");
	});

	it("removes [permissions.network] when it appears in the middle of the file", () => {
		const config = `model = "gpt-5.4"

[permissions.network]
enabled = true
allow_unix_sockets = ["/Users/testuser/.dev3.0/sockets"]

[projects."/Users/testuser/my-project"]
trust_level = "trusted"
`;
		const result = cleanupCodexConfig(config);
		expect(result).not.toContain("[permissions.network]");
		expect(result).toContain('model = "gpt-5.4"');
		expect(result).toContain('[projects."/Users/testuser/my-project"]');
		expect(result).toContain('trust_level = "trusted"');
	});

	it("removes [permissions.network] when it appears at the very start of the file", () => {
		const config = `[permissions.network]
enabled = true
allow_unix_sockets = ["/Users/testuser/.dev3.0/sockets"]

[projects."/Users/testuser/my-project"]
trust_level = "trusted"
`;
		const result = cleanupCodexConfig(config);
		expect(result).not.toContain("[permissions.network]");
		expect(result).toContain('[projects."/Users/testuser/my-project"]');
		expect(result).toContain('trust_level = "trusted"');
	});

	it("handles [permissions.network] with extra keys we didn't add", () => {
		// If user somehow added their own keys — still remove the whole section
		const config = `model = "gpt-5.4"

[permissions.network]
enabled = true
allow_unix_sockets = ["/Users/testuser/.dev3.0/sockets"]
some_other_key = "value"

[projects."/Users/testuser/my-project"]
trust_level = "trusted"
`;
		const result = cleanupCodexConfig(config);
		expect(result).not.toContain("[permissions.network]");
		expect(result).not.toContain("some_other_key");
		expect(result).toContain('[projects."/Users/testuser/my-project"]');
	});

	it("handles [permissions.network] with multiline allow_unix_sockets array", () => {
		const config = `model = "gpt-5.4"

[permissions.network]
enabled = true
allow_unix_sockets = [
  "/Users/testuser/.dev3.0/sockets",
  "/tmp/other.sock"
]

[projects."/Users/testuser/my-project"]
trust_level = "trusted"
`;
		const result = cleanupCodexConfig(config);
		expect(result).not.toContain("[permissions.network]");
		expect(result).not.toContain("allow_unix_sockets");
		expect(result).toContain('[projects."/Users/testuser/my-project"]');
	});

	it("only removes [permissions.network], not other [permissions.*] sections", () => {
		const config = `model = "gpt-5.4"

[permissions.filesystem]
allow_read = ["/tmp"]

[permissions.network]
enabled = true
allow_unix_sockets = ["/Users/testuser/.dev3.0/sockets"]

[projects."/Users/testuser/my-project"]
trust_level = "trusted"
`;
		const result = cleanupCodexConfig(config);
		expect(result).not.toContain("[permissions.network]");
		expect(result).toContain("[permissions.filesystem]");
		expect(result).toContain('allow_read = ["/tmp"]');
	});

	it("does not touch [permissions.network] if it has no dev3 socket path", () => {
		const config = `model = "gpt-5.4"

[permissions.network]
enabled = true
allow_unix_sockets = ["/tmp/my-own.sock"]

[projects."/Users/testuser/my-project"]
trust_level = "trusted"
`;
		const result = cleanupCodexConfig(config);
		expect(result).toBe(config);
	});

	it("does not remove commented-out [permissions.network]", () => {
		const config = `model = "gpt-5.4"

# [permissions.network]
# enabled = true
`;
		const result = cleanupCodexConfig(config);
		expect(result).toContain("# [permissions.network]");
		expect(result).toContain("# enabled = true");
	});
});
