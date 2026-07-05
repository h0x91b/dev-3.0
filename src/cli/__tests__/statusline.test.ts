import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveOriginalStatusLine } from "../commands/statusline";

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
		expect(resolveOriginalStatusLine(projectDir, home)).toBeNull();
	});

	it("finds the user-level statusLine in ~/.claude/settings.json", () => {
		writeSettings(home, { type: "command", command: "echo user" });
		expect(resolveOriginalStatusLine(projectDir, home)).toEqual({ command: "echo user" });
	});

	it("prefers project settings.local.json over project settings.json over user settings", () => {
		writeSettings(home, { type: "command", command: "echo user" });
		writeSettings(projectDir, { type: "command", command: "echo project" });
		expect(resolveOriginalStatusLine(projectDir, home)).toEqual({ command: "echo project" });

		mkdirSync(join(projectDir, ".claude"), { recursive: true });
		writeFileSync(
			join(projectDir, ".claude", "settings.local.json"),
			JSON.stringify({ statusLine: { type: "command", command: "echo local" } }),
		);
		expect(resolveOriginalStatusLine(projectDir, home)).toEqual({ command: "echo local" });
	});

	it("skips a statusLine that points back at dev3 statusline (recursion guard)", () => {
		writeSettings(home, { type: "command", command: '"/Users/x/.dev3.0/bin/dev3" statusline' });
		expect(resolveOriginalStatusLine(projectDir, home)).toBeNull();
	});

	it("skips corrupt settings files and falls through to the next level", () => {
		mkdirSync(join(projectDir, ".claude"), { recursive: true });
		writeFileSync(join(projectDir, ".claude", "settings.json"), "{not json");
		writeSettings(home, { type: "command", command: "echo user" });
		expect(resolveOriginalStatusLine(projectDir, home)).toEqual({ command: "echo user" });
	});

	it("ignores non-command statusLine shapes and blank commands", () => {
		writeSettings(home, { type: "static", text: "hi" });
		expect(resolveOriginalStatusLine(projectDir, home)).toBeNull();
		writeSettings(home, { type: "command", command: "   " });
		expect(resolveOriginalStatusLine(projectDir, home)).toBeNull();
	});

	it("works with a null projectDir (user settings only)", () => {
		writeSettings(home, { type: "command", command: "echo user" });
		expect(resolveOriginalStatusLine(null, home)).toEqual({ command: "echo user" });
	});
});
