import { describe, expect, it } from "vitest";
import { agentBinaryPathOverride, binaryPathMatchesCommand, brokenCustomPath, enforcedCustomBinaryPaths, staleCustomPath } from "../executable";

describe("binaryPathMatchesCommand", () => {
	it("matches the same binary: plain names, path commands, Windows launchers and separators, extension on either side", () => {
		for (const [path, command] of [
			["/usr/local/bin/claude", "claude"],
			["/Users/x/.local/bin/claude", "claude"],
			["/opt/homebrew/bin/codex", "/usr/bin/codex"],
			["C:\\bin\\claude.exe", "claude"],
			["C:\\bin\\claude.cmd", "claude"],
			["C:\\bin\\Claude.EXE", "claude"],
			["C:\\bin\\claude.cmd", "claude.exe"],
			["C:\\bin\\claude", "claude.exe"],
		]) {
			expect(binaryPathMatchesCommand(path, command), `${path} ~ ${command}`).toBe(true);
		}
	});

	it("rejects another binary, directories, empty names and non-launcher suffixes", () => {
		for (const [path, command] of [
			["/Users/x/.local/bin/claude", "claude-codex"],
			["/usr/local/bin/claude-codex", "claude"],
			["/opt/homebrew/bin/", "claude"],
			["", "claude"],
			["/usr/bin/claude", ""],
			["/usr/local/bin/claude.bak", "claude"],
			["/usr/local/bin/claude.sh", "claude"],
		]) {
			expect(binaryPathMatchesCommand(path, command), `${path} ~ ${command}`).toBe(false);
		}
	});
});

describe("agentBinaryPathOverride", () => {
	const cached = { claude: "/usr/local/bin/claude" };

	it("uses the cached path only while it still names the base command, and nothing for an agent that never saved one", () => {
		expect(agentBinaryPathOverride("claude", "claude", cached, undefined)).toBe("/usr/local/bin/claude");
		expect(agentBinaryPathOverride("claude", "claude-codex", cached, undefined)).toBeUndefined();
		expect(agentBinaryPathOverride("codex", "codex", cached, {})).toBeUndefined();
	});

	it("keeps a user-chosen path whose file name differs, preferring it over an auto-cached one", () => {
		const custom = { claude: "/opt/wrappers/claude-wrapper" };
		expect(agentBinaryPathOverride("claude", "claude", undefined, custom)).toBe("/opt/wrappers/claude-wrapper");
		expect(agentBinaryPathOverride("claude", "claude", cached, custom)).toBe("/opt/wrappers/claude-wrapper");
	});
});

describe("stale pre-strict custom paths", () => {
	const gone = "/definitely/gone/claude";
	const works = process.execPath;

	it("a gone path with no strict entry is stale and left out of the enforced paths", () => {
		const settings = { agentCustomBinaryPaths: { a: gone, b: works } };
		expect(staleCustomPath("a", settings)).toBe(gone);
		expect(enforcedCustomBinaryPaths(settings)).toEqual({ b: works });
		expect(brokenCustomPath("a", enforcedCustomBinaryPaths(settings))).toBeNull();
		// A working pre-strict path is not stale.
		expect(staleCustomPath("b", settings)).toBeNull();
	});

	it("a gone path chosen strictly is broken, never stale", () => {
		const settings = { agentCustomBinaryPaths: { a: gone }, strictAgentCustomBinaryPaths: { a: gone } };
		expect(staleCustomPath("a", settings)).toBeNull();
		expect(brokenCustomPath("a", enforcedCustomBinaryPaths(settings))).toBe(gone);
	});

	it("a strict entry for a different path (rewritten by an older build) does not make the current one strict", () => {
		const settings = { agentCustomBinaryPaths: { a: gone }, strictAgentCustomBinaryPaths: { a: "/older/choice" } };
		expect(staleCustomPath("a", settings)).toBe(gone);
	});

});
