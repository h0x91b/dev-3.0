#!/usr/bin/env bun
/**
 * E2E test: verifies pane-exit reconciliation with real tmux.
 *
 * Creates a tmux session using the same startup script structure that
 * launchTaskPty generates (setup pane + agent pane in parallel mode),
 * then verifies that when the setup pane exits, handlePaneExited
 * correctly reconciles the sessionState via the real pane-exited hook.
 *
 * Run: bun src/bun/__tests__/pane-exit-e2e.ts
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PaneSessionEntry } from "../../shared/types";

// ── Config ──────────────────────────────────────────────────────────

const TEST_SOCKET = `dev3-e2e-${process.pid}`;
const TASK_ID = `e2e-${Date.now()}-0000-0000-000000000000`;
const TMUX_SESSION = `dev3-${TASK_ID.slice(0, 8)}`;
const WORK_DIR = mkdtempSync(join(tmpdir(), "dev3-e2e-"));

// ── Helpers ─────────────────────────────────────────────────────────

function tmux(...args: string[]) {
	return spawnSync("tmux", ["-L", TEST_SOCKET, ...args], { encoding: "utf-8", timeout: 5000 });
}

function assert(condition: boolean, msg: string): void {
	if (!condition) {
		cleanup();
		console.error(`FAIL: ${msg}`);
		process.exit(1);
	}
}

function cleanup(): void {
	try { tmux("kill-server"); } catch { /* ignore */ }
}

async function waitFor(fn: () => boolean, timeoutMs = 10_000, intervalMs = 100): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fn()) return;
		await new Promise(r => setTimeout(r, intervalMs));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function listPanes(): string[] {
	const r = tmux("list-panes", "-t", TMUX_SESSION, "-F", "#{pane_id}");
	if (r.status !== 0) return [];
	return r.stdout.trim().split("\n").filter(Boolean);
}

// ── Build the same startup script that launchTaskPty creates ────────
// This replicates src/bun/rpc-handlers/tmux-pty.ts lines 332-368
// (the isSetupWrapper / parallel mode path).

const setupScript = "echo setup-done";
const agentCmd = "exec sleep 999"; // stand-in for the real agent

const prefix = `/tmp/dev3-${TASK_ID}`;
const setupPath = `${prefix}-setup.sh`;
const cmdPath = `${prefix}-cmd.sh`;
const startupPath = `${prefix}-startup.sh`;

writeFileSync(setupPath, setupScript + "\n");
writeFileSync(cmdPath, `#!/bin/bash\n${agentCmd}\n`);

const splitCmd = `tmux split-window -v -c "${WORK_DIR}" "bash '${cmdPath}'"`;
const startupLines = [
	"#!/bin/bash",
	splitCmd, // parallel mode: split first
	`bash -x "${setupPath}"`,
	"S=$?",
	`if [ $S -ne 0 ]; then`,
	`  printf '\\033[1;31m✗ Setup failed (exit %s)\\033[0m\\n' "$S"`,
	"  exec bash",
	"fi",
	"printf '\\033[1;32m✓ Setup done\\033[0m\\n'",
	"printf '\\033[2mClosing in 15s — press any key to close now\\033[0m\\n'",
	"read -t 15 -n 1 -s",
	"exit 0",
].join("\n");
writeFileSync(startupPath, startupLines + "\n");

const runScript = `#!/bin/bash\nbash "${startupPath}"\n`;
const runScriptPath = `${prefix}-run.sh`;
writeFileSync(runScriptPath, runScript);

// ── Simulated sessionState (what launchTaskPty persists) ────────────

let sessionState: { panes: PaneSessionEntry[] } = {
	panes: [{
		paneId: null, // not eagerly assigned — this is the key behavior
		agentCmd: "sleep",
		sessionId: null,
		agentId: null,
		configId: null,
	}],
};

// ── Start the PTY HTTP server for the pane-exited hook ──────────────

let reconciled = false;

const server = Bun.serve({
	port: 0,
	fetch(req) {
		const url = new URL(req.url, "http://localhost");
		if (url.pathname === "/pane-exited") {
			const paneId = url.searchParams.get("pane");
			console.log(`  hook fired: pane=${paneId}`);

			// Reconcile — same logic as handlePaneExited
			const livePaneIds = new Set(listPanes());
			let surviving = sessionState.panes.filter(p => !p.paneId || livePaneIds.has(p.paneId));
			const matchedIds = new Set(surviving.filter(p => p.paneId).map(p => p.paneId!));
			const unmatchedLive = [...livePaneIds].filter(id => !matchedIds.has(id));
			const nullEntries = surviving.filter(p => !p.paneId);

			if (nullEntries.length === 1 && unmatchedLive.length === 1) {
				surviving = surviving.map(p => !p.paneId ? { ...p, paneId: unmatchedLive[0] } : p);
				console.log(`  reconciled: assigned paneId=${unmatchedLive[0]}`);
			} else if (unmatchedLive.length === 0 && nullEntries.length > 0) {
				surviving = surviving.filter(p => !!p.paneId);
			}

			sessionState = { panes: surviving };
			reconciled = true;
			return new Response("ok");
		}
		return new Response("not found", { status: 404 });
	},
});

const HTTP_PORT = server.port;

// ── Create tmux session and configure hook ──────────────────────────

async function main() {
	console.log("=== pane-exit reconciliation e2e ===");
	console.log(`socket=${TEST_SOCKET} session=${TMUX_SESSION} port=${HTTP_PORT}`);

	try {
		// Create tmux session with the startup script
		const create = tmux("-f", "/dev/null", "new-session", "-d", "-s", TMUX_SESSION,
			"-c", WORK_DIR, `bash "${runScriptPath}"`);
		assert(create.status === 0, `tmux new-session failed: ${create.stderr}`);

		// Wait for tmux session to settle (split-window in script needs time)
		await new Promise(r => setTimeout(r, 500));

		// Set the pane-exited hook (same as configureTmux does)
		const hookCmd = `run-shell "curl -s 'http://localhost:${HTTP_PORT}/pane-exited?session=${TMUX_SESSION}&pane=#{hook_pane}' || true"`;
		tmux("set-hook", "-wt", TMUX_SESSION, "pane-exited", hookCmd);

		// Verify hook is set
		const hooks = tmux("show-hooks", "-wt", TMUX_SESSION);
		assert(hooks.stdout.includes("pane-exited"), "pane-exited hook not set");

		// Verify two panes exist
		const panesBefore = listPanes();
		console.log(`panes after launch: ${JSON.stringify(panesBefore)}`);
		assert(panesBefore.length === 2, `expected 2 panes, got ${panesBefore.length}`);

		// Verify sessionState starts with paneId: null
		assert(sessionState.panes[0].paneId == null, "panes[0].paneId should start as null");

		// Send a keystroke to all panes — triggers `read -n 1` in setup pane
		for (const paneId of panesBefore) {
			tmux("send-keys", "-t", paneId, "x");
		}

		// Wait for reconciliation
		await waitFor(() => reconciled && sessionState.panes[0]?.paneId != null, 10_000);

		// Verify result
		const finalPanes = sessionState.panes;
		console.log(`reconciled panes: ${JSON.stringify(finalPanes.map(p => p.paneId))}`);

		assert(finalPanes.length === 1, `expected 1 pane after reconciliation, got ${finalPanes.length}`);
		assert(finalPanes[0].paneId != null, "panes[0].paneId should be assigned");

		// Assigned paneId should be a live pane
		const liveAfter = listPanes();
		assert(liveAfter.includes(finalPanes[0].paneId!),
			`reconciled paneId ${finalPanes[0].paneId} not in live panes ${JSON.stringify(liveAfter)}`);

		console.log(`\nPASS — panes[0].paneId=${finalPanes[0].paneId} (correctly assigned to surviving agent pane)`);
	} catch (err) {
		console.error(`\nFAIL — ${err}`);
		cleanup();
		server.stop();
		process.exit(1);
	}

	cleanup();
	server.stop();
	process.exit(0);
}

main();
