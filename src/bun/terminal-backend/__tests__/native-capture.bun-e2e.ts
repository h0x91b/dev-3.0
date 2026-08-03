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
 *  • a pane publishing the COMPACT plain-text projection is capturable through the
 *    same seam, with a kilobyte-scale artifact and no per-cell snapshot on disk;
 *  • a pane whose host runs NO parser reports `not-enabled` — which is exactly
 *    what production does today, because the parser is off by default. The verdict
 *    comes from the host's OWN advertised capability in its record, not from a
 *    timer, so this also proves the capability is actually written and absent.
 *
 * The parser is enabled HERE ONLY, by overriding the coordinator's pane start.
 * Nothing in this file changes what production launches (decision 202).
 */

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCoordinatorDeps, type CoordinatorDeps } from "../../native-terminal-multipane/coordinator";
import { NATIVE_MULTIPANE_DIR_ENV } from "../../native-terminal-multipane/paths";
import { captureRecordFile, parserStateFile } from "../../native-terminal-registry/paths";
import {
	NATIVE_SESSION_CAPTURE_CAPABILITY,
	NATIVE_SESSION_TEXT_CAPTURE_CAPABILITY,
	readRecord,
} from "../../native-terminal-registry/record";
import type { NativeCaptureMode } from "../../native-terminal-registry/capture-mode";
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
const COMPACT_SESSION = "capture-compact";

/** One command that prints `prefix-0` … `prefix-(count-1)`, so the wait is one turn. */
function seqEcho(prefix: string, count: number): string {
	return isWindows
		? `0..${count - 1} | ForEach-Object { Write-Output "${prefix}-$_" }`
		: `for i in $(seq 0 ${count - 1}); do echo ${prefix}-$i; done`;
}

function shell(cwd: string) {
	const base = isWindows
		? { executable: "powershell.exe", argv: ["-NoLogo", "-NoProfile", "-NoExit"], cwd, env: {} }
		: { executable: "/bin/bash", argv: ["--norc", "--noprofile"], cwd, env: {} };
	return defineShellLaunchSpec(base);
}

/** The ONLY difference from production: this pane's host publishes a capture artifact. */
function withCaptureMode(captureMode: NativeCaptureMode): Partial<CoordinatorDeps> {
	return {
		startPane: (sessionId, opts) => defaultCoordinatorDeps.startPane(sessionId, { ...opts, captureMode }),
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
	const parserBackend = new NativeTerminalBackend({ deps: withCaptureMode("semantic") });
	try {
		const created = await parserBackend.openSession({
			id: PARSER_SESSION,
			cwd: root,
			launch: { executable: shell(root).executable, argv: [...shell(root).argv] },
			size: { cols: 80, rows: 24 },
		});
		const view = created.views[0]!.id;

		// One shell command, 60 rows: 60 sequential writePane round-trips made the
		// wait time depend on machine load, which is how this gate went flaky.
		await parserBackend.writePane(PARSER_SESSION, view, `${seqEcho("capture-line", 60)}${lineEnd}`);

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
				capture.sourceUpdatedAt.known && capture.lastChangeAgeMs.known && !capture.freshness.known,
				"the source's last-change time is reported as data, with freshness honestly unknown",
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

		const paneRecord = readRecord(`${PARSER_SESSION}-${view}`);
		check(
			paneRecord?.capabilities?.capture?.includes(NATIVE_SESSION_CAPTURE_CAPABILITY) === true,
			"a parser-enabled host advertises its capture surface in its own record",
		);

		const ghostPane = await parserBackend.captureView(PARSER_SESSION, "pane-99");
		check(ghostPane.availability === "view-absent", "an unknown pane reads as view-absent");
	} finally {
		await parserBackend.cleanupSession(PARSER_SESSION, { ignoreMissing: true });
		await parserBackend.dispose();
	}

	console.log("native capture — a real host publishing the COMPACT projection");
	const compactBackend = new NativeTerminalBackend({ deps: withCaptureMode("compact") });
	try {
		const created = await compactBackend.openSession({
			id: COMPACT_SESSION,
			cwd: root,
			launch: { executable: shell(root).executable, argv: [...shell(root).argv] },
			size: { cols: 120, rows: 40 },
		});
		const view = created.views[0]!.id;
		await compactBackend.writePane(COMPACT_SESSION, view, `${seqEcho("compact-line", 80)}${lineEnd}`);

		const sawNewest = await eventually("the newest line via the compact surface", async () => {
			const capture = await compactBackend.captureView(COMPACT_SESSION, view);
			return isCapturedPane(capture) && capture.content.viewport.join("\n").includes("compact-line-79");
		});
		check(sawNewest, "a pane publishing the compact projection is capturable");

		const paneSessionId = `${COMPACT_SESSION}-${view}`;
		check(
			readRecord(paneSessionId)?.capabilities?.capture?.includes(NATIVE_SESSION_TEXT_CAPTURE_CAPABILITY) === true,
			"the host advertises the plain-text capture surface, not the per-cell one",
		);
		const artifactBytes = statSync(captureRecordFile(paneSessionId)).size;
		// The per-cell snapshot is 2.5-4.8 MiB at this geometry; this is the whole point.
		check(artifactBytes < 64 * 1024, `the published artifact is small (${artifactBytes} bytes)`);
		check(
			!existsSync(parserStateFile(paneSessionId)),
			"the expensive per-cell snapshot is never written in projection mode",
		);

		// A viewer attaching and leaving flushes the producer. On a QUIET pane that
		// forced write must not reset "when the content last changed" to now.
		const quiet = await compactBackend.captureView(COMPACT_SESSION, view);
		const quietUpdatedAt = quiet.availability === "captured" ? quiet.sourceUpdatedAt : null;
		const attachment = await compactBackend.attachView(COMPACT_SESSION, view);
		await attachment.detach();
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const afterDetach = await compactBackend.captureView(COMPACT_SESSION, view);
		check(
			afterDetach.availability === "captured" &&
				quietUpdatedAt !== null &&
				JSON.stringify(afterDetach.sourceUpdatedAt) === JSON.stringify(quietUpdatedAt),
			"a viewer disconnecting from a quiet pane leaves the last-change time alone",
		);

		const capture = await compactBackend.captureView(COMPACT_SESSION, view, { historyLines: 200 });
		if (!isCapturedPane(capture)) {
			check(false, `compact capture carried content (got ${describeMiss(capture)})`);
		} else {
			check(capture.content.history.length > 0, "scrolled-off output comes back as history");
			check(capture.size.known && capture.size.value.rows === 40, "the pane's real geometry is reported");
			check(
				capture.identity.incarnation.known && capture.identity.epoch.known,
				"the compact capture carries an opaque incarnation and epoch",
			);
			const rows = [...capture.content.history, ...capture.content.viewport];
			check(
				!rows.some((row) => /[\u0000-\u001F\u007F-\u009F]/.test(row)),
				"no escape sequence or control byte survives the compact surface",
			);
		}
	} finally {
		await compactBackend.cleanupSession(COMPACT_SESSION, { ignoreMissing: true });
		await compactBackend.dispose();
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

		const plainRecord = readRecord(`${PLAIN_SESSION}-${view}`);
		check(
			plainRecord !== null && plainRecord.capabilities === undefined,
			"a parser-less host advertises NO capture surface in its record",
		);
		// No settling, no waiting: the verdict is the host's own statement, so it is
		// correct on the very first read.
		const capture = await plainBackend.captureView(PLAIN_SESSION, view);
		check(
			capture.availability === "not-enabled",
			"a parser-less native pane reports not-enabled immediately, not an empty screen",
		);
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
