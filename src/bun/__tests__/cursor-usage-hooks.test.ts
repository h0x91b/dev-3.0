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

	it("installs both response and aborted-generation accounting without a task guard, idempotently", async () => {
		await writeCursorUsageHooks(userHome, POSIX, { create: true });
		expect(JSON.parse(readFileSync(hooksPath, "utf8"))).toEqual({
			version: 1,
			hooks: {
				afterAgentResponse: [{ command: POSIX_COMMAND }],
				stop: [{ command: POSIX_COMMAND }],
			},
		});
		// Idempotent after the initial write.
		expect((await writeCursorUsageHooks(userHome, POSIX)).status).toBe("unchanged");
	});

	it("preserves user settings and other hooks on the same events", async () => {
		const custom = { command: "./audit.sh", timeout: 10, matcher: "Stop" };
		writeConfig({ version: 1, setting: { enabled: true }, hooks: { stop: [custom], beforeShellExecution: [custom] } });
		await writeCursorUsageHooks(userHome, POSIX);
		expect(JSON.parse(readFileSync(hooksPath, "utf8"))).toMatchObject({
			setting: { enabled: true }, hooks: { stop: [custom, { command: POSIX_COMMAND }], beforeShellExecution: [custom] },
		});
	});

	it("replaces only managed hooks (Windows dialect, no POSIX syntax) and leaves commands merely mentioning the invocation", async () => {
		const custom = { command: "echo hook cursor-usage" };
		writeConfig({ version: 1, hooks: { stop: [custom, { command: "/old/dev3 hook cursor-usage", timeout: 4 }] } });
		await writeCursorUsageHooks(userHome, WINDOWS);
		expect(JSON.parse(readFileSync(hooksPath, "utf8")).hooks.stop).toEqual([
			custom, { command: WINDOWS_COMMAND },
		]);
		// Repeated installs across dialects keep exactly one guarded command.
		await writeCursorUsageHooks(userHome, WINDOWS);
		await writeCursorUsageHooks(userHome, POSIX);
		expect(JSON.parse(readFileSync(hooksPath, "utf8")).hooks.stop).toEqual([custom, { command: POSIX_COMMAND }]);
	});

	it("serializes simultaneous installations without stacking duplicate commands", async () => {
		await Promise.all(Array.from({ length: 4 }, () => writeCursorUsageHooks(userHome, POSIX, { create: true })));
		expect(JSON.parse(readFileSync(hooksPath, "utf8")).hooks.stop).toHaveLength(1);
	});

	it("keeps malformed or unsupported existing configuration intact", async () => {
		const configs: unknown[] = [
			"{ malformed JSON",
			"null",
			{ version: 2, hooks: {} },
			{ version: 1, hooks: [] },
			{ version: 1, hooks: { stop: "custom-command" } },
			{ version: 1, hooks: { stop: [null] } },
		];
		for (const config of configs) {
			const original = writeConfig(config);
			const result = await writeCursorUsageHooks(userHome, POSIX);
			expect([result.status, readFileSync(hooksPath, "utf8")], JSON.stringify(config)).toEqual(["skipped", original]);
		}
	});

	it("does not write through a hook file or a Cursor directory linked outside the user's home", async () => {
		const outside = join(root, "shared-hooks.json");
		writeFileSync(outside, "{}");
		mkdirSync(join(userHome, ".cursor"));
		symlinkSync(outside, hooksPath, "file");
		const result = await writeCursorUsageHooks(userHome, POSIX);
		expect([result.reason, readFileSync(outside, "utf8")]).toEqual(["symlink", "{}"]);

		rmSync(join(userHome, ".cursor"), { recursive: true });
		const outsideDir = join(root, "shared-cursor");
		mkdirSync(outsideDir);
		symlinkSync(outsideDir, join(userHome, ".cursor"), process.platform === "win32" ? "junction" : "dir");
		expect((await writeCursorUsageHooks(userHome, POSIX)).reason).toBe("symlink");
	});

	it("creates no Cursor configuration during generic installation, but installs into an existing directory", async () => {
		const result = await writeCursorUsageHooks(userHome, POSIX);
		expect({ reason: result.reason, cursorExists: existsSync(join(userHome, ".cursor")) }).toEqual({ reason: "absent", cursorExists: false });
		mkdirSync(join(userHome, ".cursor"));
		expect((await writeCursorUsageHooks(userHome, POSIX)).status).toBe("installed");
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
		// Repeated removal is a no-op that leaves the file in place.
		expect((await removeCursorUsageHooks(userHome)).status).toBe("unchanged");
		expect(existsSync(hooksPath)).toBe(true);
	});


	it("creates no Cursor directory on an unused machine, and leaves config without managed hooks untouched", async () => {
		await removeCursorUsageHooks(userHome);
		expect(existsSync(join(userHome, ".cursor"))).toBe(false);
		const original = writeConfig({ version: 1, hooks: { stop: [{ command: "./audit.sh" }] } });
		const result = await removeCursorUsageHooks(userHome);
		expect([result.status, readFileSync(hooksPath, "utf8")]).toEqual(["unchanged", original]);
	});

	it.runIf(process.platform !== "win32")("exits successfully when the configured POSIX dev3 executable was removed", async () => {
		const cli = `"${join(root, "path with spaces", "dev3")}"`;
		await writeCursorUsageHooks(userHome, { cli, posixShell: true }, { create: true });
		const command = JSON.parse(readFileSync(hooksPath, "utf8")).hooks.stop[0].command;
		const result = spawnSync("/bin/sh", ["-c", command], { input: "{\"private\":true}", encoding: "utf8" });
		expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({ status: 0, stdout: "", stderr: "" });
	});
});
