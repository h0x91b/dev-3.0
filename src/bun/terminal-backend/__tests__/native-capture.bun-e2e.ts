#!/usr/bin/env bun
/**
 * Real-host proof of read-only pane capture on the NATIVE backend (seq 1412).
 *
 * Starts a REAL registry-owned host and shell through the product seam, drives
 * real PTY output, and reads it back with `captureView` — no fakes anywhere in
 * the capture path. Two things it must prove that a fake cannot:
 *
 *  • a pane whose host runs the live parser is capturable end to end, viewport
 *    and history apart, with the snapshot's own timestamp behind the read;
 *  • a pane whose host runs NO parser reports `not-enabled` — which is exactly
 *    what production does today, because the parser is off by default.
 *
 * The parser is enabled HERE ONLY, by overriding the coordinator's pane start.
 * Nothing in this file changes what production launches (decision 199).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCoordinatorDeps, type CoordinatorDeps } from "../../native-terminal-multipane/coordinator";
import { NATIVE_MULTIPANE_DIR_ENV } from "../../native-terminal-multipane/paths";
import { defineShellLaunchSpec } from "../../native-terminal-registry/shell-launch";
import { NativeTerminalBackend } from "../native-backend";
import { isCapturedPane, type TerminalPaneCapture } from "../capture";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) console.log(`  ok   - ${message}`);
	else {
		failures++;
		console.error(`  FAIL - ${message}`);
	}
}

const isWindows = process.platform === "win32";
const lineEnd = isWindows ? "\r" : "\n";
const PARSER_SESSION = "capture-parser";
const PLAIN_SESSION = "capture-plain";

function shell(cwd: string) {
	const base = isWindows
		? { executable: "powershell.exe", argv: ["-NoLogo", "-NoProfile", "-NoExit"], cwd, env: {} }
		: { executable: "/bin/bash", argv: ["--norc", "--noprofile"], cwd, env: {} };
	return defineShellLaunchSpec(base);
}

/** The ONLY difference from production: the pane's host runs the live parser. */
function withLiveParser(): Partial<CoordinatorDeps> {
	return {
		startPane: (sessionId, opts) => defaultCoordinatorDeps.startPane(sessionId, { ...opts, liveParser: true }),
	};
}

async function eventually(
	label: string,
	attempt: () => Promise<boolean>,
	timeoutMs = 20_000,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await attempt()) return true;
		if (Date.now() >= deadline) {
			console.error(`  (timed out waiting for ${label})`);
			return false;
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}

function incarnationOf(capture: TerminalPaneCapture): string | null {
	return capture.identity.incarnation.known ? capture.identity.incarnation.value : null;
}

function describeMiss(capture: TerminalPaneCapture): string {
	return isCapturedPane(capture) ? "captured" : `${capture.availability}: ${capture.reason}`;
}

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "dev3-native-capture-"));
	process.env[NATIVE_MULTIPANE_DIR_ENV] = join(root, "multipane");

	console.log("native capture — a real host running the live parser");
	const parserBackend = new NativeTerminalBackend({ deps: withLiveParser() });
	try {
		const created = await parserBackend.openSession({
			id: PARSER_SESSION,
			cwd: root,
			launch: { executable: shell(root).executable, argv: [...shell(root).argv] },
			size: { cols: 80, rows: 24 },
		});
		const view = created.views[0]!.id;

		// Enough output that some of it must scroll off a 24-row screen.
		for (let i = 0; i < 60; i++) {
			await parserBackend.writePane(PARSER_SESSION, view, `echo capture-line-${i}${lineEnd}`);
		}

		const sawNewest = await eventually("the newest line on the visible screen", async () => {
			const capture = await parserBackend.captureView(PARSER_SESSION, view);
			return isCapturedPane(capture) && capture.content.viewport.join("\n").includes("capture-line-59");
		});
		check(sawNewest, "a real native pane's visible screen is capturable");

		const capture = await parserBackend.captureView(PARSER_SESSION, view, { historyLines: 200 });
		if (!isCapturedPane(capture)) {
			check(false, `capture carried content (got ${describeMiss(capture)})`);
		} else {
			check(capture.content.history.length > 0, "output that scrolled off comes back as history");
			check(
				!capture.content.history.some((row) => capture.content.viewport.includes(row) && row.trim() !== ""),
				"no content row appears in both the history and the viewport",
			);
			check(capture.content.lineModel === "physical-rows", "rows are reported as physical rows");
			check(capture.liveness === "live", "a running pane reads as live");
			check(capture.size.known && capture.size.value.rows === 24, "the pane's real geometry is reported");
			check(
				capture.sourceUpdatedAt.known && capture.ageMs.known,
				"the snapshot's own update time is reported apart from the read",
			);
			check(
				capture.identity.incarnation.known && capture.identity.epoch.known,
				"the capture carries an opaque pane incarnation and a session epoch",
			);
			const allRows = [...capture.content.history, ...capture.content.viewport];
			check(
				!allRows.some((row) => /[\u0000-\u001F\u007F-\u009F]/.test(row)),
				"no escape sequence or control byte survives into captured text",
			);
			check(capture.bounds.bytesReturned <= capture.bounds.bytesLimit, "the byte budget is respected");
		}

		const again = await parserBackend.captureView(PARSER_SESSION, view);
		check(
			incarnationOf(again) !== null && incarnationOf(again) === incarnationOf(capture),
			"the same pane keeps its incarnation across captures",
		);

		const ghostPane = await parserBackend.captureView(PARSER_SESSION, "pane-99");
		check(ghostPane.availability === "view-absent", "an unknown pane reads as view-absent");
	} finally {
		await parserBackend.cleanupSession(PARSER_SESSION, { ignoreMissing: true });
		await parserBackend.dispose();
	}

	console.log("native capture — a real host with NO parser (production's shape today)");
	const plainBackend = new NativeTerminalBackend();
	try {
		const created = await plainBackend.openSession({
			id: PLAIN_SESSION,
			cwd: root,
			launch: { executable: shell(root).executable, argv: [...shell(root).argv] },
			size: { cols: 80, rows: 24 },
		});
		const view = created.views[0]!.id;
		await plainBackend.writePane(PLAIN_SESSION, view, `echo invisible${lineEnd}`);

		// The grace window has to elapse before silence means "no parser" rather
		// than "not yet" — that distinction is the point of the test.
		const settled = await eventually("the not-enabled verdict to settle", async () => {
			const capture = await plainBackend.captureView(PLAIN_SESSION, view);
			return capture.availability === "not-enabled";
		});
		const capture = await plainBackend.captureView(PLAIN_SESSION, view);
		check(settled, "a parser-less native pane reports not-enabled, not an empty screen");
		check(!isCapturedPane(capture), "a parser-less pane carries no content at all");
		check(
			capture.availability !== "captured" && capture.identity.incarnation.known,
			"even a not-enabled miss identifies the pane it missed on",
		);
		check(capture.liveness === "live", "a parser-less pane is still reported as alive");
	} finally {
		await plainBackend.cleanupSession(PLAIN_SESSION, { ignoreMissing: true });
		await plainBackend.dispose();
	}

	delete process.env[NATIVE_MULTIPANE_DIR_ENV];
	rmSync(root, { recursive: true, force: true });

	if (failures > 0) {
		console.error(`\n${failures} check(s) failed`);
		process.exit(1);
	}
	console.log("\nall native capture checks passed");
}

await main();
