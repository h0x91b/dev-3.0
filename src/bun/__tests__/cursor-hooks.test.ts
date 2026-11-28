import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeCursorHooks, writeCursorHooks } from "../cursor-hooks";

const POSIX = { cli: "~/.dev3.0/bin/dev3", posixShell: true };
const WINDOWS = { cli: '"C:/Users/Alice Smith/.dev3.0/bin/dev3.exe"', posixShell: false };
const POSIX_COMMAND = "if [ -x ~/.dev3.0/bin/dev3 ]; then ~/.dev3.0/bin/dev3 hook cursor-usage; fi";
const WINDOWS_COMMAND = `if (Test-Path -LiteralPath ${WINDOWS.cli} -PathType Leaf) { $input | & ${WINDOWS.cli} hook cursor-usage }; exit 0`;
const posixStatus = (event: string) => ({
	command: `if [ -n "$DEV3_TASK_ID" ] && [ -x ~/.dev3.0/bin/dev3 ]; then ~/.dev3.0/bin/dev3 hook cursor ${event}; else printf '{}'; fi`,
	timeout: 10,
});
const windowsStatus = (event: string) => ({
	command: `if ($env:DEV3_TASK_ID -and (Test-Path -LiteralPath ${WINDOWS.cli} -PathType Leaf)) { $input | & ${WINDOWS.cli} hook cursor ${event} } else { '{}' }; exit 0`,
	timeout: 10,
});

describe("Cursor status and accounting hook installation", () => {
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

	it("installs task-guarded status hooks beside unguarded accounting, idempotently", async () => {
		await writeCursorHooks(userHome, POSIX, { create: true });
		expect(JSON.parse(readFileSync(hooksPath, "utf8"))).toEqual({
			version: 1,
			hooks: {
				afterAgentResponse: [{ command: POSIX_COMMAND }],
				stop: [posixStatus("stop"), { command: POSIX_COMMAND }],
				beforeSubmitPrompt: [posixStatus("beforeSubmitPrompt")],
				postToolUse: [posixStatus("postToolUse")],
			},
		});
		// Idempotent after the initial write.
		expect((await writeCursorHooks(userHome, POSIX)).status).toBe("unchanged");
	});

	it("preserves user settings and other hooks on the same events", async () => {
		const custom = { command: "./audit.sh", timeout: 10, matcher: "Stop" };
		writeConfig({ version: 1, setting: { enabled: true }, hooks: {
			stop: [custom], beforeShellExecution: [custom], beforeSubmitPrompt: [custom], postToolUse: [custom],
		} });
		await writeCursorHooks(userHome, POSIX);
		expect(JSON.parse(readFileSync(hooksPath, "utf8"))).toMatchObject({
			setting: { enabled: true }, hooks: {
				stop: [custom, posixStatus("stop"), { command: POSIX_COMMAND }],
				beforeShellExecution: [custom],
				beforeSubmitPrompt: [custom, posixStatus("beforeSubmitPrompt")],
				postToolUse: [custom, posixStatus("postToolUse")],
			},
		});
	});

	it("replaces only managed hooks (Windows dialect, no POSIX syntax) and leaves commands merely mentioning the invocation", async () => {
		const custom = { command: "echo hook cursor-usage" };
		const lookalike = { command: "echo hook cursor stop" };
		writeConfig({ version: 1, hooks: { stop: [custom, lookalike, { command: "/old/dev3 hook cursor-usage", timeout: 4 }, { command: "/old/dev3 hook cursor stop" }] } });
		await writeCursorHooks(userHome, WINDOWS);
		expect(JSON.parse(readFileSync(hooksPath, "utf8")).hooks.stop).toEqual([
			custom, lookalike, windowsStatus("stop"), { command: WINDOWS_COMMAND },
		]);
		// Repeated installs across dialects keep exactly one guarded command of each kind.
		await writeCursorHooks(userHome, WINDOWS);
		await writeCursorHooks(userHome, POSIX);
		const hooks = JSON.parse(readFileSync(hooksPath, "utf8")).hooks;
		expect(hooks.stop).toEqual([custom, lookalike, posixStatus("stop"), { command: POSIX_COMMAND }]);
		expect(hooks.postToolUse).toEqual([posixStatus("postToolUse")]);
	});

	it("serializes simultaneous installations without stacking duplicate commands", async () => {
		await Promise.all(Array.from({ length: 4 }, () => writeCursorHooks(userHome, POSIX, { create: true })));
		expect(JSON.parse(readFileSync(hooksPath, "utf8")).hooks.stop).toHaveLength(2);
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
			const result = await writeCursorHooks(userHome, POSIX);
			expect([result.status, readFileSync(hooksPath, "utf8")], JSON.stringify(config)).toEqual(["skipped", original]);
		}
	});

	it("does not write through a hook file or a Cursor directory linked outside the user's home", async () => {
		const outside = join(root, "shared-hooks.json");
		writeFileSync(outside, "{}");
		mkdirSync(join(userHome, ".cursor"));
		symlinkSync(outside, hooksPath, "file");
		const result = await writeCursorHooks(userHome, POSIX);
		expect([result.reason, readFileSync(outside, "utf8")]).toEqual(["symlink", "{}"]);

		rmSync(join(userHome, ".cursor"), { recursive: true });
		const outsideDir = join(root, "shared-cursor");
		mkdirSync(outsideDir);
		symlinkSync(outsideDir, join(userHome, ".cursor"), process.platform === "win32" ? "junction" : "dir");
		expect((await writeCursorHooks(userHome, POSIX)).reason).toBe("symlink");
	});

	it("creates no Cursor configuration during generic installation, but installs into an existing directory", async () => {
		const result = await writeCursorHooks(userHome, POSIX);
		expect({ reason: result.reason, cursorExists: existsSync(join(userHome, ".cursor")) }).toEqual({ reason: "absent", cursorExists: false });
		mkdirSync(join(userHome, ".cursor"));
		expect((await writeCursorHooks(userHome, POSIX)).status).toBe("installed");
	});

	it("removes legacy and guarded hooks while preserving unrelated hooks and settings", async () => {
		const custom = { command: "echo hook cursor-usage" };
		writeConfig({ version: 1, setting: { enabled: true }, hooks: {
			stop: [custom, { command: "/old/dev3 hook cursor-usage" }, { command: WINDOWS_COMMAND }, windowsStatus("stop")],
			afterAgentResponse: [{ command: POSIX_COMMAND }], beforeShellExecution: [{ command: "./audit.sh" }],
			beforeSubmitPrompt: [posixStatus("beforeSubmitPrompt")], postToolUse: [{ command: "./audit.sh" }, posixStatus("postToolUse")],
		} });
		await removeCursorHooks(userHome);
		expect(JSON.parse(readFileSync(hooksPath, "utf8"))).toEqual({ version: 1, setting: { enabled: true }, hooks: {
			stop: [custom], beforeShellExecution: [{ command: "./audit.sh" }], postToolUse: [{ command: "./audit.sh" }],
		} });
		// Repeated removal is a no-op that leaves the file in place.
		expect((await removeCursorHooks(userHome)).status).toBe("unchanged");
		expect(existsSync(hooksPath)).toBe(true);
	});


	it("creates no Cursor directory on an unused machine, and leaves config without managed hooks untouched", async () => {
		await removeCursorHooks(userHome);
		expect(existsSync(join(userHome, ".cursor"))).toBe(false);
		const original = writeConfig({ version: 1, hooks: { stop: [{ command: "./audit.sh" }] } });
		const result = await removeCursorHooks(userHome);
		expect([result.status, readFileSync(hooksPath, "utf8")]).toEqual(["unchanged", original]);
	});

	it.runIf(process.platform !== "win32")("exits successfully when the configured POSIX dev3 executable was removed", async () => {
		const cli = `"${join(root, "path with spaces", "dev3")}"`;
		await writeCursorHooks(userHome, { cli, posixShell: true }, { create: true });
		const [status, usage] = JSON.parse(readFileSync(hooksPath, "utf8")).hooks.stop;
		const run = (command: string, env: NodeJS.ProcessEnv) => {
			const result = spawnSync("/bin/sh", ["-c", command], { input: "{\"private\":true}", encoding: "utf8", env });
			return { status: result.status, stdout: result.stdout, stderr: result.stderr };
		};
		expect(run(usage.command, {})).toEqual({ status: 0, stdout: "", stderr: "" });
		expect(run(status.command, { DEV3_TASK_ID: "task-1" })).toEqual({ status: 0, stdout: "{}", stderr: "" });
	});

	it.runIf(process.platform !== "win32")("runs the status hook only inside a dev3 pane, with the event and Cursor's payload", async () => {
		const cli = join(root, "bin dir", "dev3");
		mkdirSync(join(root, "bin dir"));
		writeFileSync(cli, "#!/bin/sh\nprintf 'args=%s stdin=%s' \"$*\" \"$(cat)\"\n", { mode: 0o755 });
		await writeCursorHooks(userHome, { cli: `"${cli}"`, posixShell: true }, { create: true });
		const { command } = JSON.parse(readFileSync(hooksPath, "utf8")).hooks.postToolUse[0];
		const run = (env: NodeJS.ProcessEnv) => spawnSync("/bin/sh", ["-c", command], { input: "{\"tool_name\":\"Shell\"}", encoding: "utf8", env }).stdout;
		// Outside dev3 no dev3 process starts at all, and Cursor still gets valid JSON.
		expect(run({})).toBe("{}");
		expect(run({ DEV3_TASK_ID: "task-1" })).toBe("args=hook cursor postToolUse stdin={\"tool_name\":\"Shell\"}");
	});
});
