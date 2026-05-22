#!/usr/bin/env bun
/**
 * E2E test: verifies pane-exit reconciliation through the real launchTaskPty flow.
 *
 * Uses real tmux, real launchTaskPty (startup script generation, createSession,
 * configureTmux with pane-exited hook), and real handlePaneExited reconciliation.
 * Only data, agents, and settings are mocked (via preload).
 *
 * Run: bun run test:pane-e2e
 */
// electrobun + data + agents are stubbed via --preload (see pane-exit-e2e-preload.ts)
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Project, Task, PaneSessionEntry } from "../../shared/types";
import * as pty from "../pty-server";
import { launchTaskPty, handlePaneExited } from "../rpc-handlers/tmux-pty";

// ── Config ──────────────────────────────────────────────────────────

const TEST_SOCKET = `dev3-e2e-${process.pid}`;
const TASK_ID = `e2e-${Date.now()}-0000-0000-000000000000`;
const PROJECT_ID = `proj-e2e-${Date.now()}`;
const WORK_DIR = mkdtempSync(join(tmpdir(), "dev3-e2e-"));

// ── Set up shared state with mocked data module ─────────────────────

const project: Project = {
	id: PROJECT_ID,
	name: "E2E Test",
	path: WORK_DIR,
	setupScript: "echo setup-done",
	setupScriptLaunchMode: "parallel",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: new Date().toISOString(),
} as Project;

const task: Task = {
	id: TASK_ID,
	seq: 1,
	projectId: PROJECT_ID,
	title: "E2E pane test",
	description: "",
	status: "in-progress",
	baseBranch: "main",
	worktreePath: WORK_DIR,
	branchName: "test",
	groupId: null,
	variantIndex: null,
	agentId: null,
	configId: null,
	tmuxSocket: TEST_SOCKET,
	createdAt: new Date().toISOString(),
} as Task;

// Wire the mocked data module to our test fixtures
(globalThis as any).__e2eProject = project;
(globalThis as any).__e2eTask = task;

// ── Helpers ─────────────────────────────────────────────────────────

function assert(condition: boolean, msg: string): void {
	if (!condition) {
		cleanup();
		console.error(`FAIL: ${msg}`);
		process.exit(1);
	}
}

function cleanup(): void {
	try { pty.destroySession(TASK_ID, TEST_SOCKET); } catch { /* ignore */ }
	try { nodeSpawnSync("tmux", ["-L", TEST_SOCKET, "kill-server"]); } catch { /* ignore */ }
}

async function waitFor(fn: () => boolean, timeoutMs = 10_000, intervalMs = 100): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fn()) return;
		await new Promise(r => setTimeout(r, intervalMs));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function getSessionState(): { panes: PaneSessionEntry[] } | null {
	return (globalThis as any).__e2eSessionState;
}

// ── Wire pane-exited callback (normally done in index.ts) ───────────

pty.setOnPaneExited((taskId, paneId) => {
	handlePaneExited(taskId, paneId);
});

// ── Test ────────────────────────────────────────────────────────────

async function main() {
	console.log("=== pane-exit reconciliation e2e (real launchTaskPty) ===");
	console.log(`socket=${TEST_SOCKET} task=${TASK_ID.slice(0, 8)}`);

	try {
		// Launch with setup script — this is the REAL launchTaskPty code path
		await launchTaskPty(project, task, WORK_DIR, null, null, true, false);

		// Wait for tmux session to be ready (configureTmux runs at 200ms)
		await new Promise(r => setTimeout(r, 600));

		// Verify two panes exist: setup pane + agent pane
		const panesBefore = await pty.listPaneIds(TASK_ID, TEST_SOCKET);
		console.log(`panes after launch: ${JSON.stringify(panesBefore)}`);
		assert(panesBefore.length === 2, `expected 2 panes, got ${panesBefore.length}`);

		// Verify sessionState has panes[0] with paneId: null
		const stateBefore = getSessionState();
		assert(stateBefore !== null, "sessionState should be set");
		assert(stateBefore!.panes[0].paneId == null,
			`panes[0].paneId should be null, got ${stateBefore!.panes[0].paneId}`);
		console.log("sessionState after launch: panes[0].paneId = null (correct)");

		// Send a keystroke to trigger `read -n 1` in the setup pane (exits immediately)
		for (const paneId of panesBefore) {
			nodeSpawnSync("tmux", ["-L", TEST_SOCKET, "send-keys", "-t", paneId, "x"]);
		}

		// Wait for reconciliation: panes[0].paneId should become non-null
		await waitFor(() => getSessionState()?.panes?.[0]?.paneId != null);

		const reconciled = getSessionState()!.panes;
		console.log(`reconciled: ${JSON.stringify(reconciled.map(p => p.paneId))}`);

		assert(reconciled.length === 1, `expected 1 pane, got ${reconciled.length}`);
		assert(reconciled[0].paneId != null, "paneId should be assigned");

		// The assigned paneId should be a live pane
		const liveAfter = await pty.listPaneIds(TASK_ID, TEST_SOCKET);
		assert(liveAfter.includes(reconciled[0].paneId!),
			`paneId ${reconciled[0].paneId} not in live ${JSON.stringify(liveAfter)}`);

		console.log(`\nPASS — panes[0].paneId=${reconciled[0].paneId} (correct surviving agent pane)`);
	} catch (err) {
		console.error(`\nFAIL — ${err}`);
		cleanup();
		process.exit(1);
	}

	cleanup();
	process.exit(0);
}

main();
