#!/usr/bin/env bun
/**
 * Backend latency of CLOSING a native task pane, against REAL hosts (seq 1387).
 *
 * The sibling script `measure-native-pane-latency.ts` covers read/split/layout. This
 * one answers the question that one left open: where do the ~1.7 s of a pane close
 * actually go? It attributes every close to named phases instead of a single total:
 *
 *   classify   — the ownership verdict that gates signalling at all
 *   handshake  — connect + requestStop against the pane host
 *   exitWait   — the 100 ms registry poll until host + shell are observably gone
 *   forceTerm  — SIGTERM escalation, only when the handshake itself failed
 *   forceKill  — SIGKILL escalation, only when exitWait ran out
 *   coordinator— the remainder of closeNativeTaskPane: layout reconcile + journal write
 *
 * Run: `bun run measure:native-pane-close` (JSON to stdout, progress to stderr).
 * Everything lands in a tmpdir, so `~/.dev3.0/` is never touched.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_MULTIPANE_DIR_ENV } from "../src/bun/native-terminal-multipane/paths";
import type { StopPhase } from "../src/bun/native-terminal-registry/registry";

/** Fixed id so repeated runs address the same deterministic session id. */
const TASK_ID = "00000000-0000-4000-8000-000000013870";
const REPS = Number(process.env.CLOSE_REPS) || 7;

interface Stats {
	n: number;
	min: number;
	p50: number;
	p95: number;
	max: number;
}

function stats(samples: number[]): Stats {
	const sorted = [...samples].sort((a, b) => a - b);
	const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
	const round = (value: number): number => Math.round(value * 10) / 10;
	return {
		n: sorted.length,
		min: round(sorted[0]!),
		p50: round(at(0.5)),
		p95: round(at(0.95)),
		max: round(sorted[sorted.length - 1]!),
	};
}

function summarise(byPhase: Map<string, number[]>): Record<string, Stats> {
	const out: Record<string, Stats> = {};
	for (const [name, samples] of [...byPhase].sort(([a], [b]) => a.localeCompare(b))) {
		if (samples.length) out[name] = stats(samples);
	}
	return out;
}

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "dev3-native-pane-close-"));
	const work = join(root, "work");
	mkdirSync(work, { recursive: true });
	process.env.DEV3_NATIVE_SESSIONS_DIR = join(root, "native-sessions");
	process.env[NATIVE_MULTIPANE_DIR_ENV] = join(root, "native-multipane");
	process.env.DEV3_NATIVE_HOST_IMAGES_DIR = join(root, "host-images");
	process.env.DEV3_LOG_DIR = join(root, "logs");

	// Imported after the redirects: the path modules read these on first use.
	const panes = await import("../src/bun/native-task-panes");
	const registry = await import("../src/bun/native-terminal-registry/registry");
	const { paneSessionId } = await import("../src/bun/native-terminal-multipane/paths");
	const { nativeTaskSessionId } = await import("../src/bun/task-terminal-backend");
	const { defaultNativeShellLaunchSpec } = await import("../src/bun/native-terminal-registry/shell-launch");

	const defaults = defaultNativeShellLaunchSpec({ platform: process.platform, cwd: work, env: process.env });
	const launch = { executable: defaults.executable, argv: [...defaults.argv] };
	const spawnOpts = { cwd: work, env: {}, launch };

	const closeTotals: number[] = [];
	const stopTotals: number[] = [];
	const byPhase = new Map<string, number[]>();
	const push = (name: string, ms: number): void => {
		const bucket = byPhase.get(name) ?? [];
		bucket.push(ms);
		byPhase.set(name, bucket);
	};

	await panes.startNativeTaskPanes({ taskId: TASK_ID, cwd: work, env: {}, launch, cols: 120, rows: 40 });

	try {
		for (let rep = 0; rep < REPS; rep++) {
			// Grow to two panes so the close reconciles a layout instead of tearing down.
			const before = (await panes.nativeTaskPanesState(TASK_ID))!;
			const created = await panes.splitNativeTaskPane(TASK_ID, before.panes[0]!.paneId, "vertical", spawnOpts);

			const mark = performance.now();
			await panes.closeNativeTaskPane(TASK_ID, created.paneId);
			closeTotals.push(performance.now() - mark);
			console.error(`  close rep=${rep + 1}/${REPS}`);
		}

		// Second pass: the same teardown one level down, so the registry phases are
		// attributed directly rather than inferred from the end-to-end total.
		for (let rep = 0; rep < REPS; rep++) {
			const before = (await panes.nativeTaskPanesState(TASK_ID))!;
			const created = await panes.splitNativeTaskPane(TASK_ID, before.panes[0]!.paneId, "vertical", spawnOpts);
			const sessionId = paneSessionId(nativeTaskSessionId(TASK_ID), created.paneId);

			const mark = performance.now();
			await registry.stop(sessionId, {
				onPhase: (phase: StopPhase, ms: number) => push(phase, ms),
			});
			stopTotals.push(performance.now() - mark);

			// Let the coordinator reconcile the now-dead pane out of the tree.
			await panes.closeNativeTaskPane(TASK_ID, created.paneId).catch(() => {});
			console.error(`  stop rep=${rep + 1}/${REPS}`);
		}

		const phases = summarise(byPhase);
		const closeStats = stats(closeTotals);
		const stopStats = stats(stopTotals);
		const phaseSum = Object.values(phases).reduce((acc, s) => acc + s.p50, 0);
		console.log(
			JSON.stringify(
				{
					platform: process.platform,
					bun: Bun.version,
					shell: launch.executable,
					closeEndToEnd: closeStats,
					registryStop: stopStats,
					phases,
					/** What closeNativeTaskPane costs on top of registry.stop, at p50. */
					coordinatorOverheadP50Ms: Math.round((closeStats.p50 - stopStats.p50) * 10) / 10,
					phaseSumP50Ms: Math.round(phaseSum * 10) / 10,
				},
				null,
				2,
			),
		);
	} finally {
		await panes.stopNativeTaskPanes(TASK_ID).catch(() => {});
		rmSync(root, { recursive: true, force: true });
	}
	// The registry holds host sockets open; nothing else keeps this process useful.
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
