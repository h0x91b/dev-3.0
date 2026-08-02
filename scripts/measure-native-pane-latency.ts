#!/usr/bin/env bun
/**
 * Backend latency of native task pane actions, against REAL hosts (seq 1382).
 *
 * Answers one question: how long does the server take to answer a pane action, by
 * pane count. It is the machine half of click-to-settled; the renderer half is
 * covered deterministically by `PaneActionPropagation.test.tsx`, because a
 * wall-clock assertion on a shared dev machine is noise, not a gate.
 *
 * Run: `bun run measure:native-pane-latency` (writes JSON to stdout, logs to stderr).
 * Everything lands in a tmpdir, so `~/.dev3.0/` is never touched.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_MULTIPANE_DIR_ENV } from "../src/bun/native-terminal-multipane/paths";

/** Fixed id so repeated runs address the same deterministic session id. */
const TASK_ID = "00000000-0000-4000-8000-00000013820f";
const PANE_COUNTS = [1, 2, 4, 6];
/** Wall clock on a loaded dev machine is noisy; more reps buy a steadier p50. */
const REPS = Number(process.env.DEV3_PANE_LATENCY_REPS ?? 5);
/** Counting forks a shell per probe, which inflates the latency beside it. */
const COUNT_PROBES = process.env.DEV3_PANE_LATENCY_COUNT_PROBES !== "0";

interface Stats { n: number; min: number; p50: number; p95: number; max: number }

/**
 * Count `ps` SUBPROCESS INVOCATIONS — the load-independent half of the
 * measurement. A shim first on PATH appends one line per exec, so the number
 * reported is real forked processes, not probe requests or bytes of tally.
 * Nothing in the product knows it is being measured.
 */
function installProbeCounter(root: string): () => number {
	// The shim costs a /bin/sh per probe, so it inflates the wall clock it is
	// measured next to: set DEV3_PANE_LATENCY_COUNT_PROBES=0 for true latency.
	if (!COUNT_PROBES) return () => 0;
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	const tally = join(root, "ps-probes.log");
	writeFileSync(tally, "");
	writeFileSync(join(bin, "ps"), `#!/bin/sh\necho . >> ${JSON.stringify(tally)}\nexec /bin/ps "$@"\n`);
	chmodSync(join(bin, "ps"), 0o755);
	process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
	return () => readFileSync(tally, "utf8").split("\n").length - 1;
}

function stats(samples: number[]): Stats {
	const sorted = [...samples].sort((a, b) => a - b);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
	const round = (value: number) => Math.round(value * 10) / 10;
	return {
		n: sorted.length,
		min: round(sorted[0]!),
		p50: round(at(0.5)),
		p95: round(at(0.95)),
		max: round(sorted[sorted.length - 1]!),
	};
}

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "dev3-native-pane-latency-"));
	const work = join(root, "work");
	mkdirSync(work, { recursive: true });
	const probeCount = installProbeCounter(root);
	process.env.DEV3_NATIVE_SESSIONS_DIR = join(root, "native-sessions");
	process.env[NATIVE_MULTIPANE_DIR_ENV] = join(root, "native-multipane");
	process.env.DEV3_NATIVE_HOST_IMAGES_DIR = join(root, "host-images");
	process.env.DEV3_LOG_DIR = join(root, "logs");

	// Imported after the redirects: the path modules read these on first use.
	const panes = await import("../src/bun/native-task-panes");
	const { defaultNativeShellLaunchSpec } = await import("../src/bun/native-terminal-registry/shell-launch");
	const { restoreSplitTree } = await import("../src/shared/split-tree");
	const { applySplitLayout, nextSplitLayoutPreset, SPLIT_LAYOUT_PRESETS } =
		await import("../src/shared/split-tree-layouts");

	const defaults = defaultNativeShellLaunchSpec({ platform: process.platform, cwd: work, env: process.env });
	const launch = { executable: defaults.executable, argv: [...defaults.argv] };

	const byPaneCount: Record<string, unknown> = {};
	const startedAt = performance.now();
	await panes.startNativeTaskPanes({ taskId: TASK_ID, cwd: work, env: {}, launch, cols: 120, rows: 40 });
	const startMs = Math.round((performance.now() - startedAt) * 10) / 10;

	try {
		for (const target of PANE_COUNTS) {
			for (;;) {
				const state = await panes.nativeTaskPanesState(TASK_ID);
				if (!state || state.panes.length >= target) break;
				const from = state.panes[state.panes.length - 1]!.paneId;
				await panes.splitNativeTaskPane(TASK_ID, from, "horizontal", { cwd: work, env: {}, launch });
			}

			const readState: number[] = [];
			const layoutPreset: number[] = [];
			const layoutCycle: number[] = [];
			let readStateProbes = 0;
			for (let rep = 0; rep < REPS; rep++) {
				const probesBefore = probeCount();
				let mark = performance.now();
				const state = await panes.nativeTaskPanesState(TASK_ID);
				readState.push(performance.now() - mark);
				readStateProbes = probeCount() - probesBefore;
				const tree = restoreSplitTree(state!.layout)!;
				if (state!.panes.length < 2) continue;

				mark = performance.now();
				await panes.setNativeTaskPaneLayout(TASK_ID, applySplitLayout(tree, "even-horizontal"));
				layoutPreset.push(performance.now() - mark);

				const next = nextSplitLayoutPreset(SPLIT_LAYOUT_PRESETS[rep % SPLIT_LAYOUT_PRESETS.length]!);
				mark = performance.now();
				await panes.setNativeTaskPaneLayout(TASK_ID, applySplitLayout(tree, next));
				layoutCycle.push(performance.now() - mark);
			}

			// A split adds a pane, so measure it and close the extra one back off.
			const splitSamples: number[] = [];
			for (let rep = 0; rep < REPS; rep++) {
				const before = (await panes.nativeTaskPanesState(TASK_ID))!;
				const mark = performance.now();
				const created = await panes.splitNativeTaskPane(TASK_ID, before.panes[0]!.paneId, "vertical", {
					cwd: work,
					env: {},
					launch,
				});
				splitSamples.push(performance.now() - mark);
				await panes.closeNativeTaskPane(TASK_ID, created.paneId);
			}

			byPaneCount[String(target)] = {
				readState: stats(readState),
				/** `ps` processes one state read forks; null when counting is off. */
				readStateProbes: COUNT_PROBES ? readStateProbes : null,
				layoutPreset: layoutPreset.length ? stats(layoutPreset) : null,
				layoutCycle: layoutCycle.length ? stats(layoutCycle) : null,
				split: stats(splitSamples),
			};
			console.error(`  measured panes=${target}`);
		}

		console.log(JSON.stringify({ platform: process.platform, bun: Bun.version, startMs, byPaneCount }, null, 2));
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
