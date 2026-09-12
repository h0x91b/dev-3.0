#!/usr/bin/env bun
/**
 * Output-log E2E for the native session host, on the REAL Bun runtime — vitest
 * stubs the Bun global, so a live `Bun.Terminal` cannot run there.
 * Run: `bun run test:native-output-log-e2e`.
 *
 * The dev server's output is mirrored to `<taskDir>/logs/dev-server.log` so an
 * agent can grep it. On the tmux backend tmux does the tee; on the NATIVE backend
 * the session host does, from the same PTY callback that feeds the journal. This
 * proves that leg against a real shell on a real PTY:
 *   • a session started with an output log gets one, as plain text;
 *   • colour and carriage-return redraws are stripped, so the file greps;
 *   • the shell still sees a tty — the capture is beside the process, never a
 *     pipeline wrapped around it, which is what would cost a dev server its
 *     colours and its interactive keys;
 *   • a session started WITHOUT one writes no log anywhere: capture is per
 *     session, never inherited from the app that spawned the host.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeSessionClient } from "../client";
import { readToken } from "../record";
import { start, stop } from "../registry";
import { defaultNativeShellLaunchSpec } from "../shell-launch";

let failures = 0;
function check(condition: boolean, msg: string): void {
	if (condition) console.log(`  ok   ${msg}`);
	else {
		console.error(`  FAIL ${msg}`);
		failures++;
	}
}

async function until<T>(probe: () => T | null, timeoutMs: number): Promise<T | null> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== null) return value;
		if (Date.now() >= deadline) return null;
		await new Promise((r) => setTimeout(r, 50));
	}
}

function logText(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

async function run(): Promise<void> {
	if (process.platform === "win32") {
		console.log("SKIPPED: this E2E drives a POSIX shell; the Windows leg needs its own script.");
		return;
	}

	const root = mkdtempSync(join(tmpdir(), "dev3-native-outputlog-"));
	const work = join(root, "work");
	mkdirSync(work, { recursive: true });
	process.env.DEV3_NATIVE_SESSIONS_DIR = join(root, "sessions");
	process.env.DEV3_LOG_DIR = join(root, "logs");

	const logPath = join(root, "task", "logs", "dev-server.log");
	const defaults = defaultNativeShellLaunchSpec({ platform: process.platform, cwd: work, env: process.env });

	try {
		console.log("\n1. a session with an output log mirrors its pane as plain text");
		const session = await start("outputlog-on", {
			launch: defaults,
			cols: 100,
			rows: 30,
			timeoutMs: 15000,
			outputLogPath: logPath,
		});
		const client = new NativeSessionClient();
		await client.connect(session.record, readToken("outputlog-on")!, { timeoutMs: 5000 });

		// Colour, a progress-bar redraw, and the tty question a dev server's tooling
		// asks before it decides how to print.
		//
		// Every marker is assembled by the SHELL and never typed whole: an interactive
		// shell echoes what it is sent, so a literal marker would match its own echo
		// and prove nothing about what the shell actually printed.
		client.input("V=DEVLOG\r");
		client.input('printf "\\033[32m${V}-READY\\033[0m in 300 ms\\n"\r');
		client.input('printf "build 10%%\\rbuild 100%%-${V}\\n"\r');
		client.input('if [ -t 1 ]; then echo "${V}-TTY" YES; else echo "${V}-TTY" NO; fi\r');

		const captured = await until(() => (logText(logPath).includes("DEVLOG-TTY ") ? logText(logPath) : null), 15000);
		client.close();

		check(captured !== null, "the log file was written while the session ran");
		if (process.env.DEVLOG_E2E_DUMP) console.log("----- captured -----\n" + JSON.stringify(captured));
		const text = captured ?? "";
		check(text.includes("DEVLOG-READY in 300 ms"), "a coloured line is stored without its escapes");
		check(!text.includes("["), "no escape sequence survived into the file");
		check(
			text.includes("build 100%-DEVLOG") && !text.includes("build 10%\rbuild"),
			"a redrawn progress line collapsed to the line it ended on",
		);
		check(text.includes("DEVLOG-TTY YES"), "the shell still sees a tty — capture never wrapped it in a pipe");
		check(!text.includes("DEVLOG-TTY NO"), "the tty answer is unambiguous");

		await stop("outputlog-on", { timeoutMs: 8000 });
		check(existsSync(logPath), "the log survives the session it came from");

		console.log("\n2. a session without one writes no log at all");
		const quietLog = join(root, "task", "logs", "must-not-exist.log");
		const plain = await start("outputlog-off", { launch: defaults, cols: 100, rows: 30, timeoutMs: 15000 });
		const plainClient = new NativeSessionClient();
		await plainClient.connect(plain.record, readToken("outputlog-off")!, { timeoutMs: 5000 });
		plainClient.input("echo DEVLOG-SHOULD-NOT-BE-LOGGED\r");
		await new Promise((r) => setTimeout(r, 2000));
		plainClient.close();
		await stop("outputlog-off", { timeoutMs: 8000 });
		check(!existsSync(quietLog), "no log file appeared for an ordinary pane");
	} finally {
		await stop("outputlog-on", { timeoutMs: 5000 }).catch(() => {});
		await stop("outputlog-off", { timeoutMs: 5000 }).catch(() => {});
		rmSync(root, { recursive: true, force: true });
	}
}

await run();
if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
