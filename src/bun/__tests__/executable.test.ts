import { describe, expect, it } from "vitest";
import { agentBinaryPathOverride, binaryPathMatchesCommand } from "../executable";

describe("binaryPathMatchesCommand", () => {
	it("matches when the saved path names the same binary", () => {
		expect(binaryPathMatchesCommand("/usr/local/bin/claude", "claude")).toBe(true);
		expect(binaryPathMatchesCommand("/Users/x/.local/bin/claude", "claude")).toBe(true);
	});

	it("matches when the base command is itself a path", () => {
		expect(binaryPathMatchesCommand("/opt/homebrew/bin/codex", "/usr/bin/codex")).toBe(true);
	});

	it("matches Windows launcher extensions and separators", () => {
		expect(binaryPathMatchesCommand("C:\\bin\\claude.exe", "claude")).toBe(true);
		expect(binaryPathMatchesCommand("C:\\bin\\claude.cmd", "claude")).toBe(true);
		expect(binaryPathMatchesCommand("C:\\bin\\Claude.EXE", "claude")).toBe(true);
	});

	it("rejects a path cached for a different binary than the edited command", () => {
		expect(binaryPathMatchesCommand("/Users/x/.local/bin/claude", "claude-codex")).toBe(false);
		expect(binaryPathMatchesCommand("/usr/local/bin/claude-codex", "claude")).toBe(false);
	});

	it("rejects directories and empty names", () => {
		expect(binaryPathMatchesCommand("/opt/homebrew/bin/", "claude")).toBe(false);
		expect(binaryPathMatchesCommand("", "claude")).toBe(false);
		expect(binaryPathMatchesCommand("/usr/bin/claude", "")).toBe(false);
	});

	it("rejects a suffix that is not a launcher extension", () => {
		expect(binaryPathMatchesCommand("/usr/local/bin/claude.bak", "claude")).toBe(false);
		expect(binaryPathMatchesCommand("/usr/local/bin/claude.sh", "claude")).toBe(false);
	});

	it("matches a launcher extension written on either side", () => {
		expect(binaryPathMatchesCommand("C:\\bin\\claude.cmd", "claude.exe")).toBe(true);
		expect(binaryPathMatchesCommand("C:\\bin\\claude", "claude.exe")).toBe(true);
	});
});

describe("agentBinaryPathOverride", () => {
	const cached = { claude: "/usr/local/bin/claude" };

	it("uses the cached path while it still names the base command", () => {
		expect(agentBinaryPathOverride("claude", "claude", cached, undefined)).toBe("/usr/local/bin/claude");
	});

	it("drops the cached path once the base command names another binary", () => {
		expect(agentBinaryPathOverride("claude", "claude-codex", cached, undefined)).toBeUndefined();
	});

	it("keeps a user-chosen path whose file name differs from the base command", () => {
		const custom = { claude: "/opt/wrappers/claude-wrapper" };
		expect(agentBinaryPathOverride("claude", "claude", undefined, custom)).toBe("/opt/wrappers/claude-wrapper");
	});

	it("prefers the user's path over an auto-cached one", () => {
		const custom = { claude: "/opt/wrappers/claude-wrapper" };
		expect(agentBinaryPathOverride("claude", "claude", cached, custom)).toBe("/opt/wrappers/claude-wrapper");
	});

	it("has no override for an agent that never saved one", () => {
		expect(agentBinaryPathOverride("codex", "codex", cached, {})).toBeUndefined();
	});
});
