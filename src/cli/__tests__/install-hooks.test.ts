import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRemoveCursorUsageHooks } from "../commands/install-hooks";
import { resolveHelp } from "../help";

describe("remove Cursor usage hooks command", () => {
	let root: string;
	beforeEach(() => { root = mkdtempSync(join(tmpdir(), "dev3-remove-cursor-")); });
	afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

	it("removes managed user hooks without a running app or worktree context", async () => {
		const directory = join(root, ".cursor");
		mkdirSync(directory);
		const path = join(directory, "hooks.json");
		writeFileSync(path, JSON.stringify({ version: 1, theme: "custom", hooks: {
			stop: [{ command: "./audit.sh" }, { command: "/old/dev3 hook cursor-usage" }],
		} }));
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await handleRemoveCursorUsageHooks(root);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, theme: "custom", hooks: { stop: [{ command: "./audit.sh" }] } });
	});

	it("does not create Cursor configuration when none exists", async () => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await handleRemoveCursorUsageHooks(root);
		expect(existsSync(join(root, ".cursor"))).toBe(false);
	});

	it("documents the removal option and its offline behavior", () => {
		const result = resolveHelp(["install-hooks", "--help"]);
		expect(result.action === "command" && result.text).toContain("dev3 install-hooks [--remove-cursor]");
	});
});
