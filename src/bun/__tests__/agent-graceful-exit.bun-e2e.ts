#!/usr/bin/env bun
/**
 * The graceful agent exit against a REAL tmux server, through the production pane-input
 * seam and the production TmuxClient. A fake agent stands in for the CLI: it survives
 * Ctrl-C the way a real TUI does, runs its "session-end hook" (appends a line to a file)
 * only when `/exit` is typed, and dies silently on SIGHUP — exactly the behaviour that
 * lost the hook under `kill-session`. The pane hands over to a shell after the agent
 * exits, like `buildCmdScript` does with `keepShell`.
 *
 * Run: `DEV3_HOME=$(mktemp -d) bun run test:agent-graceful-exit-e2e`
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../../shared/types";
import { requestGracefulAgentExit } from "../agent-graceful-exit";
import { PANE_ID_FORMAT, taskSessionName, TmuxClient } from "../tmux";

const SOCKET = `dev3-live-exit-${process.pid}`;
const client = new TmuxClient({ socket: SOCKET });
let root = "";
let failures = 0;

function check(condition: boolean, message: string): void {
	console.log(`  ${condition ? "ok  " : "FAIL"} - ${message}`);
	if (!condition) failures += 1;
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function writeScripts(hookDelaySeconds: number): { launcher: string; log: string } {
	const log = join(root, `hook-${hookDelaySeconds}.log`);
	const agent = join(root, `fake-agent-${hookDelaySeconds}.sh`);
	const launcher = join(root, `launcher-${hookDelaySeconds}.sh`);
	writeFileSync(agent, `#!/bin/bash
# Survive Ctrl-C like a TUI; die silently on SIGHUP like a CLI under kill-session.
trap 'true' INT
trap 'exit 0' HUP
echo "fake agent ready"
while IFS= read -r line; do
  if [ "$line" = "/exit" ]; then
    sleep ${hookDelaySeconds}
    echo "SessionEnd $(date +%s)" >> "${log}"
    exit 0
  fi
done
`);
	// The pane keeps living after the agent: this is what the real launch script does.
	writeFileSync(launcher, `#!/bin/bash
trap 'true' INT
bash "${agent}"
exec sh
`);
	chmodSync(agent, 0o755);
	chmodSync(launcher, 0o755);
	return { launcher, log };
}

async function startTask(hookDelaySeconds: number): Promise<{ task: Task; log: string; session: string }> {
	const taskId = crypto.randomUUID();
	const session = taskSessionName(taskId);
	const { launcher, log } = writeScripts(hookDelaySeconds);
	await client.newSessionDetached({ sessionName: session, socket: SOCKET, command: `bash "${launcher}"`, cwd: root });
	await client.ensureServerToken({ socket: SOCKET, candidate: `srv-${process.pid}` });
	const [pane] = await client.listPanes(PANE_ID_FORMAT, { target: session, socket: SOCKET });
	if (!pane) throw new Error("no pane");
	// Let the fake agent reach its read loop before anything is typed at it.
	await settle(400);
	const task = {
		id: taskId,
		projectId: "p",
		title: "live",
		description: "",
		status: "in-progress",
		createdAt: 0,
		updatedAt: 0,
		tmuxSocket: SOCKET,
		sessionState: {
			panes: [{ paneId: pane.paneId, agentCmd: "claude", sessionId: null, agentId: null, configId: null, agentFamily: "claude" }],
		},
	} as unknown as Task;
	return { task, log, session };
}

async function hookRunsWhenAskedToExit(): Promise<void> {
	console.log("case: a quick hook runs before teardown");
	const { task, log, session } = await startTask(1);
	const startedAt = Date.now();
	const outcome = await requestGracefulAgentExit(task);
	const elapsed = Date.now() - startedAt;
	console.log(`  outcome: ${JSON.stringify(outcome)} in ${elapsed} ms`);
	check(outcome.kind === "exited", "the agent left on request");
	check(existsSync(log) && readFileSync(log, "utf8").includes("SessionEnd"), "the session-end hook wrote its line");
	check(elapsed < 10_000, "well inside the 30 s bound");
	await client.killSession(session, { socket: SOCKET, bestEffort: true });
}

async function hangingHookIsBounded(): Promise<void> {
	console.log("case: a hung hook does not block teardown past the bound");
	const { task, log, session } = await startTask(120);
	const startedAt = Date.now();
	const outcome = await requestGracefulAgentExit(task, { timeoutMs: 3_000 });
	const elapsed = Date.now() - startedAt;
	console.log(`  outcome: ${JSON.stringify(outcome)} in ${elapsed} ms`);
	check(outcome.kind === "timed-out", "reported as a timeout");
	check(elapsed >= 3_000 && elapsed < 6_000, "waited the bound and no longer");
	await client.killSession(session, { socket: SOCKET, bestEffort: true });
	await settle(300);
	check(!existsSync(log), "the kill that followed ran no hook (the hang was real)");
}

async function killAloneLosesTheHook(): Promise<void> {
	console.log("case: control — kill-session alone never runs the hook");
	const { log, session } = await startTask(0);
	await client.killSession(session, { socket: SOCKET, bestEffort: true });
	await settle(500);
	check(!existsSync(log), "no session-end line after a bare kill-session");
}

async function main(): Promise<void> {
	root = mkdtempSync(join(tmpdir(), "dev3-agent-exit-"));
	try {
		await hookRunsWhenAskedToExit();
		await hangingHookIsBounded();
		await killAloneLosesTheHook();
	} finally {
		await client.killServer({ socket: SOCKET }).catch(() => undefined);
		rmSync(root, { recursive: true, force: true });
	}
	console.log(failures === 0 ? "ALL OK" : `${failures} FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

void main();
