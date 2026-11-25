import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refreshClaudePreToolHooks } from "../../shared/agent-hooks";

let folder: string;
let path: string;
const legacy = { type: "command", command: "~/.dev3.0/bin/dev3 task move --status in-progress --if-status-not review-by-ai || [ $? -eq 2 ]" };
const custom = { type: "command", command: "./check-permissions.sh" };

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "cursor-inherited-hooks-"));
	mkdirSync(join(folder, ".claude"));
	path = join(folder, ".claude", "settings.local.json");
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

function write(value: unknown) { writeFileSync(path, JSON.stringify(value)); }
function read() { return JSON.parse(readFileSync(path, "utf8")); }

describe("refresh inherited Claude hooks for Cursor", () => {
	it("replaces the screenshot's legacy command while preserving user hooks and settings", () => {
		const stop = [{ hooks: [legacy] }];
		write({ permissions: { defaultMode: "acceptEdits" }, hooks: { PreToolUse: [{ matcher: "Read", hooks: [custom, legacy] }], Stop: stop } });
		expect(refreshClaudePreToolHooks(folder).written).toBe(true);
		expect(read()).toEqual({ permissions: { defaultMode: "acceptEdits" }, hooks: {
			PreToolUse: [{ matcher: "Read", hooks: [custom, { type: "command", command: expect.stringContaining("hook claude-pre-tool"), timeout: 5 }] }], Stop: stop,
		} });
		expect(refreshClaudePreToolHooks(folder).written).toBe(false);
	});

	it("does not replace dev3's advisory file claim hook", () => {
		const claim = { command: "~/.dev3.0/bin/dev3 hook claude-claim" };
		write({ hooks: { PreToolUse: [{ hooks: [claim] }] } });
		expect(refreshClaudePreToolHooks(folder).written).toBe(false);
		expect(read().hooks.PreToolUse).toEqual([{ hooks: [claim] }]);
	});

	it("leaves unreadable or unsupported settings untouched", () => {
		for (const text of ["{broken", "null", '{"hooks":{"PreToolUse":"custom"}}']) {
			writeFileSync(path, text);
			expect(refreshClaudePreToolHooks(folder).written, text).toBe(false);
			expect(readFileSync(path, "utf8")).toBe(text);
		}
	});

	it("does not create settings in a Cursor-only worktree", () => {
		rmSync(path, { force: true });
		expect(refreshClaudePreToolHooks(folder).written).toBe(false);
		expect(existsSync(path)).toBe(false);
	});

	it("does not follow a symlink into shared settings", () => {
		const sharedFolder = mkdtempSync(join(tmpdir(), "cursor-shared-settings-"));
		const shared = join(sharedFolder, "shared.json");
		writeFileSync(shared, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [legacy] }] } }));
		symlinkSync(shared, path);
		try {
			expect(refreshClaudePreToolHooks(folder).skippedSymlink).toBeTruthy();
			expect(JSON.parse(readFileSync(shared, "utf8")).hooks.PreToolUse[0].hooks).toEqual([legacy]);
		} finally { rmSync(sharedFolder, { recursive: true, force: true }); }
	});
});
