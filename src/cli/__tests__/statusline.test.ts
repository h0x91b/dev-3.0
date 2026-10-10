import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeDumpFilePaths, configDirDumpName, resolveOriginalStatusLine, sessionDumpFilePath } from "../commands/statusline";

let tmp: string;
let projectDir: string;
let home: string;

function writeSettings(path: string, statusLine: unknown): void {
	mkdirSync(join(path, ".claude"), { recursive: true });
	writeFileSync(join(path, ".claude", "settings.json"), JSON.stringify({ statusLine }));
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "dev3-sl-test-"));
	projectDir = join(tmp, "project");
	home = join(tmp, "home");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(home, { recursive: true });
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("resolveOriginalStatusLine", () => {
	it("returns null when no settings file defines a statusLine", () => {
		expect(resolveOriginalStatusLine(projectDir, home, undefined)).toBeNull();
	});

	it("finds the user-level statusLine in ~/.claude/settings.json", () => {
		writeSettings(home, { type: "command", command: "echo user" });
		expect(resolveOriginalStatusLine(projectDir, home, undefined)).toEqual({ command: "echo user" });
	});

	it("prefers project settings.local.json over project settings.json over user settings", () => {
		writeSettings(home, { type: "command", command: "echo user" });
		writeSettings(projectDir, { type: "command", command: "echo project" });
		expect(resolveOriginalStatusLine(projectDir, home, undefined)).toEqual({ command: "echo project" });

		mkdirSync(join(projectDir, ".claude"), { recursive: true });
		writeFileSync(
			join(projectDir, ".claude", "settings.local.json"),
			JSON.stringify({ statusLine: { type: "command", command: "echo local" } }),
		);
		expect(resolveOriginalStatusLine(projectDir, home, undefined)).toEqual({ command: "echo local" });
	});

	it("skips a statusLine that points back at dev3 statusline (recursion guard)", () => {
		writeSettings(home, { type: "command", command: '"/Users/x/.dev3.0/bin/dev3" statusline' });
		expect(resolveOriginalStatusLine(projectDir, home, undefined)).toBeNull();
	});

	it("skips corrupt settings files and falls through to the next level", () => {
		mkdirSync(join(projectDir, ".claude"), { recursive: true });
		writeFileSync(join(projectDir, ".claude", "settings.json"), "{not json");
		writeSettings(home, { type: "command", command: "echo user" });
		expect(resolveOriginalStatusLine(projectDir, home, undefined)).toEqual({ command: "echo user" });
	});

	it("ignores non-command statusLine shapes and blank commands", () => {
		writeSettings(home, { type: "static", text: "hi" });
		expect(resolveOriginalStatusLine(projectDir, home, undefined)).toBeNull();
		writeSettings(home, { type: "command", command: "   " });
		expect(resolveOriginalStatusLine(projectDir, home, undefined)).toBeNull();
	});

	it("reads user-level settings from CLAUDE_CONFIG_DIR instead of ~/.claude when it is set", () => {
		const configDir = join(tmp, "config");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "echo config" } }));
		writeSettings(home, { type: "command", command: "echo user" });
		expect(resolveOriginalStatusLine(projectDir, home, configDir)).toEqual({ command: "echo config" });
	});

	it("falls back to ~/.claude when CLAUDE_CONFIG_DIR is blank", () => {
		writeSettings(home, { type: "command", command: "echo user" });
		expect(resolveOriginalStatusLine(projectDir, home, "  ")).toEqual({ command: "echo user" });
	});

	it("works with a null projectDir (user settings only)", () => {
		writeSettings(home, { type: "command", command: "echo user" });
		expect(resolveOriginalStatusLine(null, home, undefined)).toEqual({ command: "echo user" });
	});
});

describe("claudeDumpFilePaths", () => {
	const base = "/base";

	it("writes the system login (no managed id) to the shared claude.json", () => {
		expect(claudeDumpFilePaths(null, base)).toEqual([join(base, "claude.json")]);
	});

	it("writes a managed account to its own per-account file only (never claude.json)", () => {
		const paths = claudeDumpFilePaths("acc-123", base);
		expect(paths).toEqual([join(base, "claude", "acc-123.json")]);
		expect(paths).not.toContain(join(base, "claude.json"));
	});

	it("writes a project-pinned config dir to its own per-dir file, never claude.json", () => {
		const paths = claudeDumpFilePaths(null, base, "/work/proj/.claude");
		expect(paths).toEqual([join(base, "claude-config-dirs", `${configDirDumpName("/work/proj/.claude")}.json`)]);
	});

	it("lets a managed account id win over a config dir", () => {
		expect(claudeDumpFilePaths("acc-123", base, "/work/proj/.claude")).toEqual([join(base, "claude", "acc-123.json")]);
	});

	it("names each config dir stably and distinctly", () => {
		expect(configDirDumpName("/a/.claude")).toBe(configDirDumpName("/a/.claude"));
		expect(configDirDumpName("/a/.claude")).not.toBe(configDirDumpName("/b/.claude"));
		expect(configDirDumpName("/a/.claude")).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe("sessionDumpFilePath", () => {
	it("writes one dump per dev3 task under sessions/", () => {
		expect(sessionDumpFilePath("9994e79b-4c1b", "/base")).toBe(join("/base", "sessions", "9994e79b-4c1b.json"));
	});

	it("writes nothing outside a task or for an unsafe id", () => {
		expect(sessionDumpFilePath(undefined, "/base")).toBeNull();
		expect(sessionDumpFilePath("  ", "/base")).toBeNull();
		expect(sessionDumpFilePath("../escape", "/base")).toBeNull();
	});
});
