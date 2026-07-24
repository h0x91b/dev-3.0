#!/usr/bin/env bun
/**
 * Native single-view parity E2E (seq 1254). Drives the SHARED, backend-neutral
 * parity corpus (`terminal-parity/checks.ts`) against the native single-view
 * adapter on the REAL Bun runtime — the same checks that prove the tmux backend,
 * now proving native. vitest stubs the Bun global, so this runs as a standalone
 * `bun` script (mirrors `test:native-registry-e2e`). Run:
 *   bun run test:native-parity-e2e
 *
 * Platform coverage:
 *  - POSIX: the shared single-view LIVE scenarios (they use a POSIX `sh`) + the
 *    backend-neutral PURE scenarios + a native lifecycle smoke.
 *  - Native Windows: the PURE scenarios + the native lifecycle smoke on the real
 *    Windows shell (the POSIX `sh` shared checks are not applicable and are
 *    logged as such). The registry's Windows lifecycle is already proven by the
 *    sibling native e2e; this adds the adapter's capture/reconnect/cleanup on top.
 *
 * It records the exact multi-view scenarios deferred to LAY-003/LAY-004.
 * Expected final line: `ALL CHECKS PASSED`.
 */

import { LIVE_CHECKS, PURE_CHECKS, type CheckContext } from "../../terminal-parity/checks";
import { getScenario } from "../../terminal-parity/corpus";
import { isProcessAlive } from "../../native-terminal-registry/process-identity";
import { readRecord } from "../../native-terminal-registry/record";
import {
	createNativeParityHarness,
	detectNativeRuntime,
	NATIVE_DEFERRED_MULTI_VIEW_SCENARIOS,
	NATIVE_PURE_SCENARIOS,
	NATIVE_SINGLE_VIEW_LIVE_SCENARIOS,
} from "../index";

const isWindows = process.platform === "win32";
/** The shared corpus checks are authored in POSIX shell — applicable on POSIX. */
const SHARED_LIVE_APPLICABLE = !isWindows;

let failures = 0;
function pass(msg: string): void {
	console.log(`  ok   - ${msg}`);
}
function fail(msg: string, err?: unknown): void {
	failures++;
	console.error(`  FAIL - ${msg}${err ? `: ${err instanceof Error ? err.stack ?? err.message : String(err)}` : ""}`);
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function runSharedLive(id: string): Promise<void> {
	const check = LIVE_CHECKS[id];
	if (!check) {
		fail(`${id} (no shared check found)`);
		return;
	}
	const harness = createNativeParityHarness();
	const ctx: CheckContext = { cwd: harness.workDir, reconnect: harness.reconnect };
	try {
		await check(harness.runner as never, ctx);
		pass(`live/${id}`);
	} catch (err) {
		fail(`live/${id}`, err);
	} finally {
		await harness.dispose().catch(() => {});
	}
}

function runPure(id: string): void {
	const check = PURE_CHECKS[id];
	if (!check) {
		fail(`${id} (no pure check found)`);
		return;
	}
	try {
		check();
		pass(`pure/${id}`);
	} catch (err) {
		fail(`pure/${id}`, err);
	}
}

async function captureUntil(
	runner: ReturnType<typeof createNativeParityHarness>["runner"],
	id: string,
	viewId: string,
	needle: string,
	timeoutMs = 8000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let last = "";
	while (Date.now() < deadline) {
		last = await runner.capture(id, viewId, { includeHistory: true });
		if (last.includes(needle)) return last;
		await delay(100);
	}
	throw new Error(`capture never contained ${JSON.stringify(needle)} (last: ${JSON.stringify(last.slice(-200))})`);
}

/**
 * The core adapter lifecycle on the real per-platform shell (POSIX `sh` /
 * Windows PowerShell): create, presence, input → snapshot capture, fresh-process
 * reconnect capture, then owned-tree cleanup with an idempotent retry. This is
 * the native Windows coverage for the adapter (the shared corpus is POSIX-only).
 */
async function nativeLifecycleSmoke(): Promise<void> {
	const harness = createNativeParityHarness();
	const id = `native-smoke-${process.pid}`;
	const marker = `NATIVE-MARKER-${process.pid}`;
	// `command: undefined` on Windows selects the default Windows shell; `echo` is
	// a builtin in both `sh` and PowerShell.
	const command = isWindows ? undefined : "sh";
	try {
		const { firstViewId } = await harness.runner.createSession({ id, cwd: harness.workDir, command });
		if (!(await harness.runner.isSessionPresent(id))) throw new Error("session not present after create");

		const record = readRecord(id);
		if (!record) throw new Error("no record for a freshly created native session");
		const { pid: hostPid } = record.host;
		const { pid: shellPid } = record.shell;

		await harness.runner.sendInput(id, firstViewId, `echo ${marker}`);
		await captureUntil(harness.runner, id, firstViewId, marker);
		pass("native/create+input+capture");

		// A fresh controller (models a new process) rediscovers the same view + state.
		const fresh = harness.reconnect();
		const freshViews = await fresh.listViews(id);
		if (!freshViews.some((v) => v.id === firstViewId)) throw new Error("fresh controller lost the view id");
		await captureUntil(fresh, id, firstViewId, marker);
		pass("native/fresh-controller-reconnect");

		await harness.runner.cleanupSession(id);
		const deadline = Date.now() + 6000;
		while (Date.now() < deadline && (isProcessAlive(hostPid) || isProcessAlive(shellPid))) await delay(100);
		if (isProcessAlive(hostPid) || isProcessAlive(shellPid)) throw new Error("owned host/shell tree survived cleanup");
		if (await harness.runner.isSessionPresent(id)) throw new Error("session still present after cleanup");
		// Idempotent best-effort retry is quiet; strict retry reports absence.
		await harness.runner.cleanupSession(id, { bestEffort: true });
		let strictThrew = false;
		try {
			await harness.runner.cleanupSession(id);
		} catch {
			strictThrew = true;
		}
		if (!strictThrew) throw new Error("strict cleanup of a gone session did not report absence");
		pass("native/cleanup-reaps-owned-tree+idempotent");
	} catch (err) {
		fail("native/lifecycle-smoke", err);
	} finally {
		await harness.dispose().catch(() => {});
	}
}

async function main(): Promise<void> {
	const runtime = detectNativeRuntime();
	if (!runtime) {
		console.log("SKIP: native terminal runtime unavailable (needs Bun >= 1.3.14; Windows ConPTY floor).");
		return;
	}
	console.log(`Native single-view parity E2E on Bun ${runtime} (${process.platform})`);

	console.log("\n# Single-view live scenarios (shared corpus checks vs native):");
	if (SHARED_LIVE_APPLICABLE) {
		for (const id of NATIVE_SINGLE_VIEW_LIVE_SCENARIOS) await runSharedLive(id);
	} else {
		for (const id of NATIVE_SINGLE_VIEW_LIVE_SCENARIOS) {
			console.log(`  n/a  - live/${id} (POSIX-shell shared check; native Windows covered by the lifecycle smoke)`);
		}
	}

	console.log("\n# Pure scenarios (backend-neutral):");
	for (const id of NATIVE_PURE_SCENARIOS) runPure(id);

	console.log("\n# Native lifecycle smoke (real per-platform shell):");
	await nativeLifecycleSmoke();

	console.log("\n# Deferred to multi-view layout (LAY-003/LAY-004) — shared checks open a 2nd view:");
	for (const id of NATIVE_DEFERRED_MULTI_VIEW_SCENARIOS) {
		console.log(`  defer- ${id} (${getScenario(id).title})`);
	}

	console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
	if (failures > 0) process.exit(1);
}

main().catch((err) => {
	console.error("native parity E2E crashed:", err);
	process.exit(1);
});
