#!/usr/bin/env bun
/**
 * Short-lived APP CONTROLLER for the product task-terminal tracer (seq 1292).
 *
 * One invocation models ONE disposable dev3 app process that comes up, reattaches
 * to a task's native primary terminal through the PRODUCT path
 * (`attachNativeTaskTerminal`), prints a single structured JSON verdict, and exits
 * without ever stopping the detached host. Two uses:
 *
 *   reattach   after an app restart — must find the SAME host/shell and receive the
 *              replayed screen state, with no second spawn.
 *   reattach   after cleanup — must report `attached:false` and spawn nothing.
 *
 * The verdict goes to stdout behind a sentinel prefix; human logs go to stderr.
 */

import { readdirSync } from "node:fs";
import { attachNativeTaskTerminal } from "../native-task-terminal";
import { nativeTaskSessionId } from "../task-terminal-backend";
import { readRecord } from "../native-terminal-registry/record";
import { sessionsRootDir } from "../native-terminal-registry/paths";

const JSON_SENTINEL = "__TASK_TERMINAL_JSON__";
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function emit(verdict: Record<string, unknown>): void {
	process.stdout.write(`${JSON_SENTINEL}${JSON.stringify(verdict)}\n`);
}

function sessionDirCount(): number {
	try {
		return readdirSync(sessionsRootDir(), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
	} catch {
		return 0;
	}
}

async function reattach(taskId: string, marker: string): Promise<void> {
	const sessionId = nativeTaskSessionId(taskId);
	const dirsBefore = sessionDirCount();
	let replayed = "";
	const decoder = new TextDecoder();
	let closed = false;

	const terminal = await attachNativeTaskTerminal(taskId, {
		onOutput: (bytes) => {
			replayed += decoder.decode(bytes, { stream: true });
		},
		onClosed: () => {
			closed = true;
		},
	});

	if (!terminal) {
		emit({
			phase: "reattach",
			ok: true,
			attached: false,
			controllerPid: process.pid,
			sessionId,
			dirsBefore,
			dirsAfter: sessionDirCount(),
			recordPresent: readRecord(sessionId) !== null,
		});
		process.exit(0);
	}

	// The host replays its bounded journal in the same turn as the welcome, so a
	// short wait is enough — no command is sent from this controller.
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline && !replayed.includes(marker)) await delay(30);
	const sawMarker = replayed.includes(marker);

	terminal.detach();
	emit({
		phase: "reattach",
		ok: sawMarker && !closed,
		attached: true,
		controllerPid: process.pid,
		sessionId: terminal.sessionId,
		hostPid: terminal.hostPid,
		shellPid: terminal.shellPid,
		sawReplayedMarker: sawMarker,
		replayBytes: replayed.length,
		closedDuringAttach: closed,
		dirsBefore,
		dirsAfter: sessionDirCount(),
	});
	process.exit(0);
}

async function main(): Promise<void> {
	const taskId = process.argv[2];
	const marker = process.env.DEV3_NATIVE_TASK_E2E_MARKER ?? "";
	if (!taskId || !marker) {
		process.stderr.write("usage: DEV3_NATIVE_TASK_E2E_MARKER=<text> native-task-terminal-controller.ts <taskId>\n");
		process.exit(2);
	}
	await reattach(taskId, marker);
}

void main().catch((err) => {
	emit({ phase: "reattach", ok: false, error: err instanceof Error ? err.message : String(err) });
	process.exit(1);
});
