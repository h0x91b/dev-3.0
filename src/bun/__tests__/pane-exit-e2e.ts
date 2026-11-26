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
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Project, Task, PaneSessionEntry } from "../../shared/types";
import * as pty from "../pty-server";
import { launchTaskPty, routePaneExited } from "../rpc-handlers/tmux-pty";
// Leaf import, not the tmux barrel: this script runs under a preload that mocks
// whole modules, and the barrel pulls in far more than the unlink helper.
import { removeTmuxSocketFile } from "../tmux/socket-files";

// ── Config ──────────────────────────────────────────────────────────

// The hooks this run installs must never touch the user's real tmux server (`-L dev3`).
if (!process.env.TMUX_TMPDIR || process.env.TMUX_TMPDIR !== process.env.DEV3_TEST_SOCKET_ROOT) {
	console.error(`FAIL: TMUX_TMPDIR must be the isolated socket root, got ${JSON.stringify(process.env.TMUX_TMPDIR)} — run through \`bun run test:pane-e2e\``);
	process.exit(1);
}

const TEST_SOCKET = `dev3-e2e-${process.pid}`;
const TASK_ID = `e2e-${Date.now()}-0000-0000-000000000000`;
const PROJECT_ID = `proj-e2e-${Date.now()}`;
const WORK_DIR = mkdtempSync(join(tmpdir(), "dev3-e2e-"));
// A git project's launchers refuse a folder without `.git` (task-workspace-guard):
// the fixture must look like a real worktree, not just an empty temp dir.
nodeSpawnSync("git", ["init", "-q", WORK_DIR], { stdio: "ignore" });

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

function tmuxSync(args: string[]): ReturnType<typeof nodeSpawnSync> {
	// Bun's node:child_process compatibility layer snapshots the launch env;
	// pass the test-specific TMUX_TMPDIR explicitly after preload isolation.
	return nodeSpawnSync("tmux", args, { env: { ...process.env } });
}

function cleanup(): void {
	try { pty.destroySession(TASK_ID, TEST_SOCKET); } catch { /* ignore */ }
	try { tmuxSync(["-L", TEST_SOCKET, "kill-server"]); } catch { /* ignore */ }
	// kill-server leaves the socket FILE behind, and this name is pid-keyed.
	removeTmuxSocketFile(TEST_SOCKET);
	try { rmSync(WORK_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
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

const exitCallbacks: Array<{ taskId: string | null; paneId: string }> = [];

// ── Wire pane-exited callback (normally done in index.ts) ───────────

pty.setOnPaneExited((taskId, paneId) => {
	exitCallbacks.push({ taskId, paneId });
	routePaneExited(taskId, paneId);
});

// ── Test ────────────────────────────────────────────────────────────

async function main() {
	console.log("=== pane-exit reconciliation e2e (real launchTaskPty) ===");
	console.log(`socket=${TEST_SOCKET} task=${TASK_ID.slice(0, 8)} TMUX_TMPDIR=${process.env.TMUX_TMPDIR}`);

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
			tmuxSync(["-L", TEST_SOCKET, "send-keys", "-t", paneId, "x"]);
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

		console.log(`panes[0].paneId=${reconciled[0].paneId} (correct surviving agent pane)`);

		// An agent alone in its own window exits while ANOTHER tab is current: tmux resolves the
		// hook from that tab, so every tab must carry it, whoever opened it.
		const session = pty.getSessionTmuxName(TASK_ID);
		const mainEntry = reconciled[0];
		const tmuxOut = (args: string[]): string => String(tmuxSync(["-L", TEST_SOCKET, ...args]).stdout).trim();
		const newWindow = (name: string, command: string): string =>
			tmuxOut(["new-window", "-d", "-n", name, "-t", `${session}:`, "-P", "-F", "#{pane_id}", command]);
		const agentEntry = (paneId: string) => ({ paneId, window: "Agents", agentCmd: "sleep", sessionId: null, agentId: null, configId: null });
		const hooksOf = (target: string, scope: "-w" | "-g" | ""): string => tmuxOut(["show-hooks", ...(scope ? [scope] : []), "-t", target]);

		// Keys typed after the prefix (Ctrl+B) in a real attached client.
		const pressKeys = (keys: string): void => {
			const run = nodeSpawnSync("python3", ["-I", "-c", [
				"import os,pty,sys,time",
				"pid,fd=pty.fork()",
				"if pid==0: os.execvp('tmux',['tmux','-L',sys.argv[1],'attach','-t',sys.argv[2]])",
				"time.sleep(1); os.write(fd,b'\\x02'+sys.argv[3].encode()); time.sleep(1); os.kill(pid,9)",
			].join("\n"), TEST_SOCKET, session, keys], { env: { ...process.env, TMUX: "" } });
			assert(run.status === 0, `could not drive the Ctrl+B ${keys} client: ${run.stderr}`);
		};
		const activeWindowId = (): string => tmuxOut(["display-message", "-p", "-t", session, "#{window_id}"]);

		const expectAgentsExitCleansUp = async (label: string, agentPane: string): Promise<void> => {
			(globalThis as any).__e2eSessionState = { panes: [mainEntry, agentEntry(agentPane)] };
			await waitFor(() => !getSessionState()!.panes.some(p => p.paneId === agentPane), 15_000);
			assert(exitCallbacks.some(c => c.paneId === agentPane && c.taskId === TASK_ID), `${label}: the callback should reach with the Agents pane id`);
			const left = getSessionState()!.panes;
			assert(left.length === 1 && left[0].paneId === mainEntry.paneId, `${label}: only the Agents entry should be removed`);
			console.log(`PASS — ${label}`);
		};

		// A tab a user opens with the shipped Ctrl+B c binding, in a real attached client.
		const agentA = newWindow("Agents", "bash -c 'sleep 4'");
		pressKeys("c");
		const windows = tmuxOut(["list-windows", "-t", session, "-F", "#{window_active} #{window_name}"]);
		assert(windows.split("\n").length === 3 && windows.split("\n").some(w => w.startsWith("1 ")), `Ctrl+B c should open a current third tab, got ${JSON.stringify(windows)}`);
		assert(hooksOf(activeWindowId(), "-w").includes("pane-exited"), "a tab opened with Ctrl+B c should carry the pane-exited hook");
		await expectAgentsExitCleansUp("Agents exits while a Ctrl+B c tab is current", agentA);

		// A tab open before dev3 (re)configured the session: reattach hooks every existing window.
		const legacyPane = newWindow("Legacy", "sleep 999");
		const legacyWindow = tmuxOut(["display-message", "-p", "-t", legacyPane, "#{window_id}"]);
		tmuxOut(["set-hook", "-wu", "-t", legacyWindow, "pane-exited"]);
		tmuxOut(["set-hook", "-u", "-t", session, "window-linked"]);
		assert(!hooksOf(legacyWindow, "-w").includes("pane-exited"), "setup: the legacy tab should start without the hook");
		await pty.installPaneExitedHooks(session, TEST_SOCKET);
		assert(hooksOf(legacyWindow, "-w").includes("pane-exited"), "reattach should hook a tab that already existed");
		assert(hooksOf(session, "").includes("window-linked"), "reattach should restore the new-window hook");
		tmuxOut(["select-window", "-t", legacyWindow]);
		await expectAgentsExitCleansUp("Agents exits while a pre-existing tab is current", newWindow("Agents", "bash -c 'sleep 3'"));

		// A window Ctrl+B ! (break-pane) makes never fires after-new-window; window-linked covers it.
		const mainWindow = tmuxOut(["display-message", "-p", "-t", mainEntry.paneId!, "#{window_id}"]);
		const splitPane = tmuxOut(["split-window", "-d", "-t", mainEntry.paneId!, "-P", "-F", "#{pane_id}", "sleep 999"]);
		tmuxOut(["select-window", "-t", mainWindow]);
		tmuxOut(["select-pane", "-t", splitPane]);
		const agentB = newWindow("Agents", "bash -c 'sleep 4'");
		pressKeys("!");
		assert(activeWindowId() !== mainWindow, "Ctrl+B ! should select the broken-out window");
		assert(hooksOf(activeWindowId(), "-w").includes("pane-exited"), "a window made by Ctrl+B ! should carry the pane-exited hook");
		await expectAgentsExitCleansUp("Agents exits while a Ctrl+B ! window is current", agentB);

		// A session that survived an app restart still points at the previous app's port; the --window spawn refreshes it first.
		const STALE = `run-shell "curl -s 'http://127.0.0.1:1/pane-exited?session=${session}&pane=#{hook_pane}' || true"`;
		for (const row of tmuxOut(["list-windows", "-t", session, "-F", "#{window_id}"]).split("\n")) {
			tmuxOut(["set-hook", "-w", "-t", row, "pane-exited", STALE]);
		}
		tmuxOut(["set-hook", "-t", session, "window-linked", `set-hook -w pane-exited "${STALE.replace(/["\\]/g, "\\$&")}"`]);
		await pty.installPaneExitedHooks(session, TEST_SOCKET);
		assert(!hooksOf(activeWindowId(), "-w").includes("127.0.0.1:1/"), "the spawn preflight should re-point an existing window at this app");
		await expectAgentsExitCleansUp("Agents exits in a window opened after a restart", newWindow("Agents", "bash -c 'sleep 3'"));

		console.log("\nPASS — surviving main pane kept, exited Agents-window entries removed");
	} catch (err) {
		console.error(`\nFAIL — ${err}`);
		cleanup();
		process.exit(1);
	}

	cleanup();
	process.exit(0);
}

main();
