import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeCursorUsageHooks } from "../cursor-usage-hooks";

const POSIX = { cli: "~/.dev3.0/bin/dev3", posixShell: true };
const WINDOWS = { cli: '"C:/Users/Alice Smith/.dev3.0/bin/dev3.exe"', posixShell: false };

describe("Cursor accounting hook installation", () => {
	let root: string;
	let userHome: string;
	let hooksPath: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dev3-cursor-hooks-"));
		userHome = join(root, "user");
		mkdirSync(userHome);
		hooksPath = join(userHome, ".cursor", "hooks.json");
	});
	afterEach(() => { rmSync(root, { recursive: true, force: true }); });

	function writeConfig(content: unknown): string {
		mkdirSync(join(userHome, ".cursor"), { recursive: true });
		const text = typeof content === "string" ? content : JSON.stringify(content);
		writeFileSync(hooksPath, text);
		return text;
	}

	it("installs both response and aborted-generation accounting without a task guard", async () => {
		await writeCursorUsageHooks(userHome, POSIX);
		expect(JSON.parse(readFileSync(hooksPath, "utf8"))).toEqual({
			version: 1,
			hooks: {
				afterAgentResponse: [{ command: "~/.dev3.0/bin/dev3 hook cursor-usage" }],
				stop: [{ command: "~/.dev3.0/bin/dev3 hook cursor-usage" }],
			},
		});
	});

	it("uses the Windows CLI dialect without POSIX-only shell syntax", async () => {
		await writeCursorUsageHooks(userHome, WINDOWS);
		expect(JSON.parse(readFileSync(hooksPath, "utf8")).hooks.stop).toEqual([
			{ command: '"C:/Users/Alice Smith/.dev3.0/bin/dev3.exe" hook cursor-usage' },
		]);
	});

	it("preserves user settings and other hooks on the same events", async () => {
		const custom = { command: "./audit.sh", timeout: 10, matcher: "Stop" };
		writeConfig({ version: 1, setting: { enabled: true }, hooks: { stop: [custom], beforeShellExecution: [custom] } });
		await writeCursorUsageHooks(userHome, POSIX);
		expect(JSON.parse(readFileSync(hooksPath, "utf8"))).toMatchObject({
			setting: { enabled: true }, hooks: { stop: [custom, { command: "~/.dev3.0/bin/dev3 hook cursor-usage" }], beforeShellExecution: [custom] },
		});
	});

	it("replaces only managed hooks and leaves commands merely mentioning the invocation", async () => {
		const custom = { command: "echo hook cursor-usage" };
		writeConfig({ version: 1, hooks: { stop: [custom, { command: "/old/dev3 hook cursor-usage", timeout: 4 }] } });
		await writeCursorUsageHooks(userHome, WINDOWS);
		expect(JSON.parse(readFileSync(hooksPath, "utf8")).hooks.stop).toEqual([
			custom, { command: `${WINDOWS.cli} hook cursor-usage` },
		]);
	});

	it("is idempotent after the initial write", async () => {
		await writeCursorUsageHooks(userHome, POSIX);
		expect((await writeCursorUsageHooks(userHome, POSIX)).status).toBe("unchanged");
	});

	it("serializes simultaneous installations without stacking duplicate commands", async () => {
		await Promise.all(Array.from({ length: 4 }, () => writeCursorUsageHooks(userHome, POSIX)));
		expect(JSON.parse(readFileSync(hooksPath, "utf8")).hooks.stop).toHaveLength(1);
	});

	it.each([
		"{ malformed JSON",
		"null",
		{ version: 2, hooks: {} },
		{ version: 1, hooks: [] },
		{ version: 1, hooks: { stop: "custom-command" } },
		{ version: 1, hooks: { stop: [null] } },
	])("keeps malformed or unsupported existing configuration intact (%j)", async (config) => {
		const original = writeConfig(config);
		const result = await writeCursorUsageHooks(userHome, POSIX);
		expect([result.status, readFileSync(hooksPath, "utf8")]).toEqual(["skipped", original]);
	});

	it("does not overwrite a hook file linked outside the user's home", async () => {
		const outside = join(root, "shared-hooks.json");
		writeFileSync(outside, "{}");
		mkdirSync(join(userHome, ".cursor"));
		symlinkSync(outside, hooksPath, "file");
		const result = await writeCursorUsageHooks(userHome, POSIX);
		expect([result.reason, readFileSync(outside, "utf8")]).toEqual(["symlink", "{}"]);
	});

	it("does not write through a Cursor configuration directory linked outside home", async () => {
		const outside = join(root, "shared-cursor");
		mkdirSync(outside);
		symlinkSync(outside, join(userHome, ".cursor"), process.platform === "win32" ? "junction" : "dir");
		expect((await writeCursorUsageHooks(userHome, POSIX)).reason).toBe("symlink");
	});
});
