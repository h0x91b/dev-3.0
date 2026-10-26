import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeCursorUsageHooks, writeCursorUsageHooks } from "../cursor-usage-hooks";

const POSIX = { cli: "~/.dev3.0/bin/dev3", posixShell: true };
const WINDOWS = { cli: '"C:/Users/Alice Smith/.dev3.0/bin/dev3.exe"', posixShell: false };
const POSIX_COMMAND = "if [ -x ~/.dev3.0/bin/dev3 ]; then ~/.dev3.0/bin/dev3 hook cursor-usage; fi";
const WINDOWS_COMMAND = `if (Test-Path -LiteralPath ${WINDOWS.cli} -PathType Leaf) { $input | & ${WINDOWS.cli} hook cursor-usage }; exit 0`;

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
		await writeCursorUsageHooks(userHome, POSIX, { create: true });
		expect(JSON.parse(readFileSync(hooksPath, "utf8"))).toEqual({
			version: 1,
			hooks: {
				afterAgentResponse: [{ command: POSIX_COMMAND }],
				stop: [{ command: POSIX_COMMAND }],
			},
		});
	});

	it("uses the Windows CLI dialect without POSIX-only shell syntax", async () => {
		await writeCursorUsageHooks(userHome, WINDOWS, { create: true });
		expect(JSON.parse(readFileSync(hooksPath, "utf8")).hooks.stop).toEqual([
			{ command: WINDOWS_COMMAND },
		]);
	});

	it("preserves user settings and other hooks on the same events", async () => {
		const custom = { command: "./audit.sh", timeout: 10, matcher: "Stop" };
		writeConfig({ version: 1, setting: { enabled: true }, hooks: { stop: [custom], beforeShellExecution: [custom] } });
		await writeCursorUsageHooks(userHome, POSIX);
		expect(JSON.parse(readFileSync(hooksPath, "utf8"))).toMatchObject({
			setting: { enabled: true }, hooks: { stop: [custom, { command: POSIX_COMMAND }], beforeShellExecution: [custom] },
		});
	});

	it("replaces only managed hooks and leaves commands merely mentioning the invocation", async () => {
		const custom = { command: "echo hook cursor-usage" };
		writeConfig({ version: 1, hooks: { stop: [custom, { command: "/old/dev3 hook cursor-usage", timeout: 4 }] } });
		await writeCursorUsageHooks(userHome, WINDOWS);
		expect(JSON.parse(readFileSync(hooksPath, "utf8")).hooks.stop).toEqual([
			custom, { command: WINDOWS_COMMAND },
		]);
	});

	it("is idempotent after the initial write", async () => {
		await writeCursorUsageHooks(userHome, POSIX, { create: true });
		expect((await writeCursorUsageHooks(userHome, POSIX)).status).toBe("unchanged");
	});

	it("serializes simultaneous installations without stacking duplicate commands", async () => {
		await Promise.all(Array.from({ length: 4 }, () => writeCursorUsageHooks(userHome, POSIX, { create: true })));
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

	it("does not create Cursor configuration during generic hook installation", async () => {
		const result = await writeCursorUsageHooks(userHome, POSIX);
		expect({ reason: result.reason, cursorExists: existsSync(join(userHome, ".cursor")) }).toEqual({ reason: "absent", cursorExists: false });
	});

	it("installs hooks for an existing Cursor directory without an explicit create option", async () => {
		mkdirSync(join(userHome, ".cursor"));
		expect((await writeCursorUsageHooks(userHome, POSIX)).status).toBe("installed");
	});

	it("upgrades legacy hooks and keeps exactly one guarded command on repeated installation", async () => {
		writeConfig({ version: 1, hooks: { stop: [{ command: "/old/dev3 hook cursor-usage" }] } });
		await writeCursorUsageHooks(userHome, WINDOWS);
		await writeCursorUsageHooks(userHome, WINDOWS);
		await writeCursorUsageHooks(userHome, POSIX);
		expect(JSON.parse(readFileSync(hooksPath, "utf8")).hooks.stop).toEqual([{ command: POSIX_COMMAND }]);
	});

	it("removes legacy and guarded hooks while preserving unrelated hooks and settings", async () => {
		const custom = { command: "echo hook cursor-usage" };
		writeConfig({ version: 1, setting: { enabled: true }, hooks: {
			stop: [custom, { command: "/old/dev3 hook cursor-usage" }, { command: WINDOWS_COMMAND }],
			afterAgentResponse: [{ command: POSIX_COMMAND }], beforeShellExecution: [{ command: "./audit.sh" }],
		} });
		await removeCursorUsageHooks(userHome);
		expect(JSON.parse(readFileSync(hooksPath, "utf8"))).toEqual({ version: 1, setting: { enabled: true }, hooks: {
			stop: [custom], beforeShellExecution: [{ command: "./audit.sh" }],
		} });
	});

	it("leaves user configuration untouched when removal finds no managed hooks", async () => {
		const original = writeConfig({ version: 1, hooks: { stop: [{ command: "./audit.sh" }] } });
		const result = await removeCursorUsageHooks(userHome);
		expect([result.status, readFileSync(hooksPath, "utf8")]).toEqual(["unchanged", original]);
	});

	it("leaves the configuration file in place and allows repeated removal", async () => {
		await writeCursorUsageHooks(userHome, POSIX, { create: true });
		await removeCursorUsageHooks(userHome);
		const result = await removeCursorUsageHooks(userHome);
		expect([result.status, JSON.parse(readFileSync(hooksPath, "utf8"))]).toEqual(["unchanged", { version: 1, hooks: {} }]);
	});

	it("does not create a Cursor directory when removing hooks on an unused machine", async () => {
		await removeCursorUsageHooks(userHome);
		expect(existsSync(join(userHome, ".cursor"))).toBe(false);
	});

	it.runIf(process.platform !== "win32")("exits successfully when the configured POSIX dev3 executable was removed", async () => {
		const cli = `"${join(root, "path with spaces", "dev3")}"`;
		await writeCursorUsageHooks(userHome, { cli, posixShell: true }, { create: true });
		const command = JSON.parse(readFileSync(hooksPath, "utf8")).hooks.stop[0].command;
		const result = spawnSync("/bin/sh", ["-c", command], { input: "{\"private\":true}", encoding: "utf8" });
		expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({ status: 0, stdout: "", stderr: "" });
	});
});
