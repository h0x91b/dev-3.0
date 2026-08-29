#!/usr/bin/env bun
/**
 * Closing one auxiliary pane must close THAT pane and nothing else (seq 1744).
 *
 * The report: on Windows, a task with two auxiliary panes shut down entirely when
 * the FIRST of them was closed, while the second was still in use. Losing a task's
 * terminal under a running agent is the worst shape of bug this app has, so the
 * guard has to sit on the path the UI really takes, not on a helper beside it.
 *
 * WHAT THIS PROVES AND WHAT IT CANNOT. It exercises the real call chain a close
 * click runs — `taskPaneAction` (the RPC the renderer's `runPaneAction` calls) →
 * `nativePaneAction` → `closeNativeTaskPane` → the native backend → the
 * coordinator — against real hosts, real shells and a real on-disk pane record.
 * It is evidence about that code path on whichever platform runs it. It is NOT a
 * reproduction of the reported gesture: nobody clicks anything here, and a
 * platform-specific failure only counts when this file has gone green or red on
 * that platform's own runner.
 *
 * Every pane close in the matrix is checked for the same three things, because
 * "the task shut down" can arrive by three different doors:
 *   1. the surviving panes are still in the pane set,
 *   2. their shells and hosts are still running,
 *   3. no `ptyDied` was published for the task — that push is what makes the
 *      renderer replace the terminal with the "session ended" screen, so it is
 *      the task dying as far as the user is concerned.
 *
 * Run: bun src/bun/__tests__/aux-pane-close-keeps-task.bun-e2e.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) console.log(`  ok   - ${message}`);
	else {
		failures++;
		console.error(`  FAIL - ${message}`);
	}
}

const isWindows = process.platform === "win32";

// ── The temp world, wired BEFORE any dev3 module loads ────────────────────────
// `DEV3_HOME` is read once at module load, so every import below has to be dynamic.
const root = mkdtempSync(join(tmpdir(), "dev3-aux-close-e2e-"));
const home = join(root, "home");
const projectPath = join(root, "project");
const worktreePath = join(root, "worktree");
mkdirSync(home, { recursive: true });
mkdirSync(projectPath, { recursive: true });
mkdirSync(worktreePath, { recursive: true });
process.env.DEV3_HOME = home;
process.env.DEV3_NATIVE_SESSIONS_DIR = join(root, "sessions");
process.env.DEV3_NATIVE_MULTIPANE_DIR = join(root, "multipane");

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";

const project = {
	id: PROJECT_ID,
	name: "aux-close-e2e",
	path: projectPath,
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: new Date(0).toISOString(),
};

const task = {
	id: TASK_ID,
	projectId: PROJECT_ID,
	seq: 1,
	title: "aux pane close",
	description: "",
	status: "in-progress",
	branch: "e2e/aux-close",
	baseBranch: "main",
	worktreePath,
	createdAt: new Date(0).toISOString(),
	updatedAt: new Date(0).toISOString(),
	terminalBackend: "native",
};

/** `projectSlug()` is frozen: `/a/b/c` → `a-b-c`. Recomputed, never imported early. */
function slugOf(path: string): string {
	return path.replace(/^\//, "").replaceAll("/", "-");
}

writeFileSync(join(home, "projects.json"), JSON.stringify([project]));
const dataDir = join(home, "data", slugOf(projectPath));
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, "tasks.json"), JSON.stringify([task]));

const { defineShellLaunchSpec } = await import("../native-terminal-registry/shell-launch");
const { isProcessAlive } = await import("../native-terminal-registry/process-identity");
const pty = await import("../pty-server");
const { taskPanesHandlers } = await import("../rpc-handlers/task-panes");
const { nativeTaskPanesState, stopNativeTaskPanes } = await import("../native-task-panes");

/** A shell that sits there: the panes must be alive for "did it survive" to mean anything. */
function shellLaunch() {
	return defineShellLaunchSpec(
		isWindows
			? { executable: "powershell.exe", argv: ["-NoLogo", "-NoProfile", "-NoExit"], cwd: worktreePath, env: {} }
			: { executable: "/bin/bash", argv: ["--norc", "--noprofile"], cwd: worktreePath, env: {} },
	);
}

/** Every `ptyDied` the backend published, in order. Empty is the passing state. */
const ptyDeaths: string[] = [];

/**
 * How long a `ptyDied` decision is given to arrive before "it never came" counts.
 *
 * The verdict is taken asynchronously — the pane set has to be read off disk after
 * the close — so asserting the instant the RPC resolves would pass while the death
 * is still in flight. That false green is real: it hid a deliberately broken build
 * during this task's own mutation check.
 */
const DEATH_SETTLE_MS = 1_500;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves as soon as a death is published, or after the settle budget. */
async function waitForDeath(): Promise<boolean> {
	const deadline = Date.now() + DEATH_SETTLE_MS;
	for (;;) {
		if (ptyDeaths.length > 0) return true;
		if (Date.now() >= deadline) return false;
		await sleep(50);
	}
}

interface PaneFacts {
	paneId: string;
	hostPid: number;
	shellPid: number;
}

async function paneFacts(): Promise<PaneFacts[]> {
	const state = await nativeTaskPanesState(TASK_ID);
	if (!state) return [];
	return state.panes.map((pane) => ({ paneId: pane.paneId, hostPid: pane.hostPid, shellPid: pane.shellPid }));
}

/**
 * Open `count` extra panes through the same RPC the "+ pane" and agent-spawn
 * gestures use, and attach a viewer to each one exactly as the renderer does —
 * `getPanePtyUrl` is what registers a pane's own PTY session, and a pane nobody
 * ever viewed would not exercise the bookkeeping a close has to unwind.
 */
async function openPanes(count: number): Promise<PaneFacts[]> {
	for (let i = 0; i < count; i++) {
		await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "splitH" } });
	}
	const panes = await paneFacts();
	for (const pane of panes) {
		await taskPanesHandlers.getPanePtyUrl({ taskId: TASK_ID, paneId: pane.paneId });
	}
	return panes;
}

/**
 * One case of the matrix: build a pane set, close the pane at `victimIndex`
 * through the close RPC, and demand that everything else survives.
 */
async function closeCase(label: string, paneCount: number, victimIndex: number): Promise<void> {
	ptyDeaths.length = 0;
	await pty.createNativeTaskSession(TASK_ID, PROJECT_ID, worktreePath, shellLaunch());
	try {
		const before = await openPanes(paneCount - 1);
		if (before.length !== paneCount) {
			check(false, `${label}: expected ${paneCount} panes before the close, got ${before.length}`);
			return;
		}
		const victim = before[victimIndex]!;
		const survivors = before.filter((_, i) => i !== victimIndex);

		await taskPanesHandlers.taskPaneAction({
			taskId: TASK_ID,
			action: { kind: "close", paneId: victim.paneId },
		});

		// The death verdict is asynchronous, so "no death" is only meaningful after
		// the budget has passed with nothing published.
		await sleep(DEATH_SETTLE_MS);

		const after = await paneFacts();
		const afterIds = new Set(after.map((pane) => pane.paneId));
		check(
			after.length === paneCount - 1,
			`${label}: ${paneCount - 1} pane(s) remain after closing pane ${victimIndex + 1} of ${paneCount} — got ${after.length}`,
		);
		check(
			survivors.every((pane) => afterIds.has(pane.paneId)),
			`${label}: every pane except the closed one is still in the pane set`,
		);
		check(!afterIds.has(victim.paneId), `${label}: the closed pane is gone from the pane set`);
		check(
			survivors.every((pane) => isProcessAlive(pane.shellPid) && isProcessAlive(pane.hostPid)),
			`${label}: every surviving pane's shell and host are still running`,
		);
		check(
			ptyDeaths.length === 0,
			`${label}: the task's terminal was never reported dead — ptyDied fired ${ptyDeaths.length} time(s)`,
		);
	} finally {
		await stopNativeTaskPanes(TASK_ID).catch(() => {});
		try {
			pty.destroySession(TASK_ID);
		} catch {
			/* already gone */
		}
	}
}

/**
 * Close a three-pane set one pane at a time. The first two closes must publish
 * nothing; the close that empties the set must publish exactly one death — that is
 * the "session ended" screen appearing when there is genuinely nothing left.
 */
async function lastPaneCase(): Promise<void> {
	const label = "closing every pane";
	ptyDeaths.length = 0;
	await pty.createNativeTaskSession(TASK_ID, PROJECT_ID, worktreePath, shellLaunch());
	try {
		const panes = await openPanes(2);
		if (panes.length !== 3) {
			check(false, `${label}: expected 3 panes to start from, got ${panes.length}`);
			return;
		}
		// Last first, so the pane holding the bare taskId is the one that empties the set.
		for (const pane of [...panes].reverse().slice(0, 2)) {
			await taskPanesHandlers.taskPaneAction({ taskId: TASK_ID, action: { kind: "close", paneId: pane.paneId } });
		}
		await sleep(DEATH_SETTLE_MS);
		check(ptyDeaths.length === 0, `${label}: nothing died while panes remained — got ${ptyDeaths.length}`);

		// `force`, because the last pane is refused without it by design.
		await taskPanesHandlers.taskPaneAction({
			taskId: TASK_ID,
			action: { kind: "close", paneId: panes[0]!.paneId, force: true },
		});
		check(await waitForDeath(), `${label}: the last pane closing DID end the task's terminal`);
		check(ptyDeaths.every((key) => key === TASK_ID), `${label}: the death was published for this task`);
	} finally {
		await stopNativeTaskPanes(TASK_ID).catch(() => {});
		try {
			pty.destroySession(TASK_ID);
		} catch {
			/* already gone */
		}
	}
}

async function run(): Promise<void> {
	pty.setOnPtyDied((sessionKey) => ptyDeaths.push(sessionKey));
	try {
		// The reported gesture, at code-path level: three panes, close the FIRST
		// auxiliary one (index 1 — index 0 is the agent's own pane).
		console.log("\n# three panes, closing the first auxiliary one");
		await closeCase("first aux of three", 3, 1);

		// Question B, the other half: if only the first is special, this one passes
		// while the case above fails. If neither is special, both pass.
		console.log("\n# three panes, closing the second auxiliary one");
		await closeCase("second aux of three", 3, 2);

		console.log("\n# four panes, closing a middle one");
		await closeCase("middle of four", 4, 1);

		// Question D: the agent's own pane is a pane like any other while others remain.
		console.log("\n# three panes, closing the agent pane itself");
		await closeCase("agent pane of three", 3, 0);

		// The other half of the rule, and the deliberate choice: the pane set running
		// out IS the task's terminal ending, so the last close must still say so.
		console.log("\n# closing every pane in turn — only the last one ends the task");
		await lastPaneCase();
	} finally {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
}

run()
	.then(() => {
		if (failures > 0) {
			console.error(`\n${failures} check(s) FAILED`);
			process.exit(1);
		}
		console.log("\nALL CHECKS PASSED");
		process.exit(0);
	})
	.catch((error) => {
		console.error("\nERROR:", error);
		process.exit(1);
	});
