import { describe, expect, it } from "vitest";
import { binaryPathMatchesCommand } from "../executable";

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
});
