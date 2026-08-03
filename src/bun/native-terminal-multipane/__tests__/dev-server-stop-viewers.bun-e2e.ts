#!/usr/bin/env bun
/**
 * Native dev-server stop, one viewer vs two (seq 1407).
 *
 * The incident: on a native task, Stop Dev Server froze the whole UI while the
 * backend teardown finished cleanly in 539 ms and the main process kept running
 * for another 49 s. The logs also show a SECOND app instance attached to the same
 * pane sessions at the time, refused the writer lease, and stalling 29 s two
 * minutes earlier. So the suspicion under test is contention on the shared native
 * host, not the pane close itself (H1), plus connection teardown that does not
 * balance per pane session (H2).
 *
 * Each cycle is the real shape of a dev-server stop: split an aux pane off the
 * agent pane, run a long-lived process in it, attach viewers to BOTH panes, then
 * `closePane` the aux pane — the very call `closeNativeTaskPane` makes. After the
 * close the surviving viewer must still complete a real round-trip through the
 * host: that is this layer's honest analogue of "the UI is still responsive".
 *
 * Run: bun src/bun/native-terminal-multipane/__tests__/dev-server-stop-viewers.bun-e2e.ts
 *      [--cycles N]
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { isProcessAlive } from "../../native-terminal-registry/process-identity";
import { defineShellLaunchSpec, type ShellLaunchSpec } from "../../native-terminal-registry/shell-launch";
import { NativeMultipaneCoordinator, type PaneConnection, type PaneLaunchSpec } from "../coordinator";
import { NATIVE_MULTIPANE_DIR_ENV, paneSessionId } from "../paths";

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

/** Round-trip budget after the aux pane closes. A wedged host blows straight past it. */
const ROUND_TRIP_BUDGET_MS = 5_000;
/** A single pane close is a click-path operation; the incident's own was 539 ms end to end. */
const CLOSE_BUDGET_MS = 5_000;

const cycles = (() => {
	const flag = process.argv.indexOf("--cycles");
	const parsed = flag >= 0 ? Number(process.argv[flag + 1]) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 20;
})();

/** Per-pane-session connection ledger — H2 is entirely about this balancing. */
interface Ledger {
	opened: Map<string, number>;
	closed: Map<string, number>;
}

function bump(counter: Map<string, number>, key: string): void {
	counter.set(key, (counter.get(key) ?? 0) + 1);
}

/** How long a socket may take to actually close before we call it unreleased. */
const DISCONNECT_BUDGET_MS = 5_000;
/** How long owned pane trees may take to die after cleanup before we force it. */
const CLEANUP_BUDGET_MS = 10_000;

async function waitUntil(predicate: () => boolean, budgetMs: number): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		if (predicate()) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/**
 * Race a promise against its OWN deadline. Every awaited teardown step gets one: a
 * step that never resolves must not be able to hang the harness and skip the
 * fallbacks behind it.
 */
async function withDeadline<T>(promise: Promise<T>, budgetMs: number, onTimeout: T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((resolve) => {
				timer = setTimeout(() => resolve(onTimeout), budgetMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * A viewer connection plus the only trustworthy evidence that it went away.
 *
 * `role()` is NOT evidence: `NativeSessionClient.close()` sets `currentRole = null`
 * synchronously, long before the socket's close event, so a socket that never closes
 * still reads as released. `onDisconnect` fires from the socket's own close event —
 * but it must be subscribed at CONNECT time, because a callback registered after the
 * socket has already gone never fires at all. That also makes a host-initiated
 * teardown (the pane closing under us) count correctly: the ledger tracks released
 * connections, not who released them.
 */
interface TrackedConnection {
	readonly sessionId: string;
	readonly connection: PaneConnection;
	/** Resolves true once the socket really closed, false if it never did in time. */
	closeAndAwaitRelease(): Promise<boolean>;
}

function track(sessionId: string, connection: PaneConnection): TrackedConnection {
	// The connection owns the evidence: whenDisconnected() is sticky, so it is correct
	// whether the socket closed before or after this call.
	const released = connection.whenDisconnected().then(() => true);
	return {
		sessionId,
		connection,
		async closeAndAwaitRelease() {
			connection.close();
			return withDeadline(released, DISCONNECT_BUDGET_MS, false);
		},
	};
}

async function closeAndRecord(counter: Map<string, number>, tracked: TrackedConnection): Promise<void> {
	if (await tracked.closeAndAwaitRelease()) bump(counter, tracked.sessionId);
}

function shellSpec(root: string, paneId: string, command?: string): PaneLaunchSpec {
	const base: ShellLaunchSpec = isWindows
		? { executable: "powershell.exe", argv: ["-NoLogo", "-NoProfile", "-NoExit"], cwd: root, env: {} }
		: { executable: "/bin/bash", argv: ["--norc", "--noprofile"], cwd: root, env: {} };
	return {
		launch: defineShellLaunchSpec({
			...base,
			env: { ...base.env, DEV3_NATIVE_PANE_ID: paneId, ...(command ? { DEV3_LAB_CMD: command } : {}) },
		}),
		cols: 80,
		rows: 24,
		timeoutMs: 20_000,
	};
}

function sinkOf(connection: PaneConnection): { waitFor: (needle: string, budgetMs: number) => Promise<boolean> } {
	let output = "";
	const decoder = new TextDecoder();
	const waiters: Array<{ needle: string; resolve: (ok: boolean) => void }> = [];
	connection.onOutput((bytes) => {
		output += decoder.decode(bytes, { stream: true });
		for (let i = waiters.length - 1; i >= 0; i--) {
			const waiter = waiters[i]!;
			if (!output.includes(waiter.needle)) continue;
			waiters.splice(i, 1);
			waiter.resolve(true);
		}
	});
	return {
		waitFor(needle, budgetMs) {
			if (output.includes(needle)) return Promise.resolve(true);
			return new Promise((resolve) => {
				const waiter = { needle, resolve };
				waiters.push(waiter);
				setTimeout(() => {
					const idx = waiters.indexOf(waiter);
					if (idx >= 0) {
						waiters.splice(idx, 1);
						resolve(false);
					}
				}, budgetMs);
			});
		},
	};
}

interface CycleStats {
	closeMs: number;
	roundTripMs: number;
	roundTripOk: boolean;
	agentAlive: boolean;
	auxTreeDead: boolean;
	remaining: number;
}

/**
 * One matrix run. `extraViewers` is the number of INDEPENDENT recovered
 * controllers attached alongside the writer — 0 reproduces a single app instance,
 * 1 reproduces the incident's two-instance state.
 */
async function runMatrix(label: string, extraViewers: number, root: string): Promise<CycleStats[]> {
	const coordinatorId = `mp1407-${extraViewers}v`;
	const ledger: Ledger = { opened: new Map(), closed: new Map() };
	const stats: CycleStats[] = [];

	// Every pid this run is responsible for, recorded as it is observed rather than
	// re-derived at the end: an inspection that fails must not be able to shrink it.
	const ownedPids = new Set<number>();
	const coordinator = await NativeMultipaneCoordinator.create(coordinatorId, shellSpec(root, "pane-1"));
	try {
		const agentPaneId = coordinator.paneIds()[0]!;
		const agentSession = paneSessionId(coordinatorId, agentPaneId);
		const agentSnapshot = (await coordinator.listPanes()).find((p) => p.paneId === agentPaneId)!;
		ownedPids.add(agentSnapshot.hostPid).add(agentSnapshot.shellPid);
		const agentConn = track(agentSession, await coordinator.connect(agentPaneId));
		bump(ledger.opened, agentSession);
		const agentSink = sinkOf(agentConn.connection);

		for (let cycle = 1; cycle <= cycles; cycle++) {
			// ── start: the dev-server aux pane, running something long-lived ────────
			const auxPaneId = await coordinator.split(agentPaneId, "vertical", shellSpec(root, `aux-${cycle}`));
			const auxSession = paneSessionId(coordinatorId, auxPaneId);
			const auxSnapshot = (await coordinator.listPanes()).find((p) => p.paneId === auxPaneId)!;
			ownedPids.add(auxSnapshot.hostPid).add(auxSnapshot.shellPid);
			const auxConn = track(auxSession, await coordinator.connect(auxPaneId));
			bump(ledger.opened, auxSession);
			// A dev server is a process that does not exit on its own.
			await coordinator.writePane(auxPaneId, `sleep 3600 &${lineEnd}`);

			// ── extra independent viewers on the SAME pane sessions ─────────────────
			const extras: Array<{ controller: NativeMultipaneCoordinator; conns: TrackedConnection[] }> = [];
			for (let v = 0; v < extraViewers; v++) {
				const observer = await NativeMultipaneCoordinator.recover(coordinatorId);
				if (!observer) continue;
				const conns: TrackedConnection[] = [];
				for (const paneId of [agentPaneId, auxPaneId]) {
					const sessionId = paneSessionId(coordinatorId, paneId);
					conns.push(track(sessionId, await observer.connect(paneId)));
					bump(ledger.opened, sessionId);
				}
				extras.push({ controller: observer, conns });
			}

			// ── stop: the exact call closeNativeTaskPane makes ──────────────────────
			const closeStartedAt = performance.now();
			const closed = await coordinator.closePane(auxPaneId);
			const closeMs = performance.now() - closeStartedAt;

			// The closing viewer's own connection to the gone pane must be released.
			await closeAndRecord(ledger.closed, auxConn);
			for (const extra of extras) {
				for (const conn of extra.conns) await closeAndRecord(ledger.closed, conn);
				extra.controller.detach();
			}

			// ── the responsiveness probe: a real round-trip through the host ────────
			// The shell echoes the command line back, so a literal marker would match
			// before anything ran. The needle is arithmetic only the shell can produce,
			// which makes a pass mean "the pane executed and the host streamed it".
			const seed = 1_000 + cycle;
			const marker = `RT-${extraViewers}-${seed * 7}`;
			const rtStartedAt = performance.now();
			await coordinator.writePane(
				agentPaneId,
				`printf 'RT-${extraViewers}-%s\\n' $(( ${seed} * 7 ))${lineEnd}`,
			);
			const roundTripOk = await agentSink.waitFor(marker, ROUND_TRIP_BUDGET_MS);
			const roundTripMs = performance.now() - rtStartedAt;

			stats.push({
				closeMs: Math.round(closeMs),
				roundTripMs: Math.round(roundTripMs),
				roundTripOk,
				agentAlive: isProcessAlive(agentSnapshot.shellPid),
				auxTreeDead: !isProcessAlive(auxSnapshot.shellPid) && !isProcessAlive(auxSnapshot.hostPid),
				remaining: closed.remainingPaneIds.length,
			});
			if (!roundTripOk) {
				console.error(`  cycle ${cycle}: round-trip TIMED OUT after ${Math.round(roundTripMs)} ms`);
				break;
			}
		}

		await closeAndRecord(ledger.closed, agentConn);

		// ── verdicts ────────────────────────────────────────────────────────────
		const ran = stats.length;
		const worstClose = Math.max(...stats.map((s) => s.closeMs));
		const worstRt = Math.max(...stats.map((s) => s.roundTripMs));
		console.log(
			`\n  ${label}: ${ran}/${cycles} cycles · worst close ${worstClose} ms · worst round-trip ${worstRt} ms`,
		);
		check(ran === cycles, `${label}: all ${cycles} cycles completed`);
		check(stats.every((s) => s.roundTripOk), `${label}: the surviving pane answered after every close`);
		check(worstRt < ROUND_TRIP_BUDGET_MS, `${label}: every round-trip stayed under ${ROUND_TRIP_BUDGET_MS} ms`);
		check(worstClose < CLOSE_BUDGET_MS, `${label}: every pane close stayed under ${CLOSE_BUDGET_MS} ms`);
		check(stats.every((s) => s.remaining === 1), `${label}: exactly the agent pane survives each close`);
		check(stats.every((s) => s.auxTreeDead), `${label}: the closed pane's process tree is gone every time`);
		check(stats.every((s) => s.agentAlive), `${label}: the agent pane's shell survives every close`);

		const unbalanced = [...ledger.opened.keys()].filter(
			(sessionId) => (ledger.opened.get(sessionId) ?? 0) !== (ledger.closed.get(sessionId) ?? 0),
		);
		check(
			unbalanced.length === 0,
			`${label}: every pane session's connections balance (opened === closed)${
				unbalanced.length
					? ` — unbalanced: ${unbalanced
							.map((id) => `${id}: ${ledger.opened.get(id)}/${ledger.closed.get(id)}`)
							.join(", ")}`
					: ""
			}`,
		);
		return stats;
	} finally {
		// A last inspection is a bonus, never the source of truth: turning its failure
		// into [] would make the every() below vacuously true. `ownedPids` was filled as
		// each pane was observed, so it stands on its own.
		const inspected = await withDeadline(coordinator.listPanes(), CLEANUP_BUDGET_MS, null).catch(
			(err) => {
				check(false, `${label}: final listPanes() failed — ${String(err)}`);
				return null;
			},
		);
		if (inspected === null) check(false, `${label}: could not inspect the pane set before cleanup`);
		else for (const pane of inspected) ownedPids.add(pane.shellPid).add(pane.hostPid);

		// Its own deadline: a cleanup that never resolves must not skip the reap below.
		const cleaned = await withDeadline(
			coordinator.cleanup().then(() => true),
			CLEANUP_BUDGET_MS,
			false,
		).catch((err) => {
			check(false, `${label}: coordinator.cleanup() threw — ${String(err)}`);
			return false;
		});
		if (!cleaned) check(false, `${label}: coordinator.cleanup() did not finish within its deadline`);

		const survivors = () => [...ownedPids].filter((pid) => isProcessAlive(pid));
		const goneOnItsOwn = await waitUntil(() => survivors().length === 0, CLEANUP_BUDGET_MS);
		for (const pid of survivors()) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
		// Re-probe AFTER the force-kill and before any record is deleted: SIGKILL is not
		// instantaneous, and "we sent a signal" is not evidence.
		const goneAfterKill = await waitUntil(() => survivors().length === 0, CLEANUP_BUDGET_MS);
		check(goneOnItsOwn, `${label}: cleanup reaped every owned pane tree without a force-kill`);
		check(goneAfterKill, `${label}: no owned pid survives even the force-kill — alive: ${survivors()}`);
	}
}

async function run(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "dev3-devstop-e2e-"));
	const shimDir = join(root, "shim");
	const sentinel = join(root, "tmux-was-invoked");
	mkdirSync(shimDir, { recursive: true });
	const shim = join(shimDir, isWindows ? "tmux.cmd" : "tmux");
	writeFileSync(
		shim,
		isWindows
			? `@echo off\r\necho called>>"${sentinel}"\r\nexit /b 0\r\n`
			: `#!/bin/sh\necho called >> "${sentinel}"\nexit 0\n`,
	);
	if (!isWindows) chmodSync(shim, 0o755);

	process.env.DEV3_NATIVE_SESSIONS_DIR = join(root, "sessions");
	process.env[NATIVE_MULTIPANE_DIR_ENV] = join(root, "multipane");
	process.env.PATH = `${shimDir}${delimiter}${process.env.PATH ?? ""}`;

	try {
		console.log(`\n# one viewer — ${cycles} dev-server start/stop cycles`);
		const single = await runMatrix("one viewer", 0, root);

		console.log(`\n# two viewers on the same pane sessions — ${cycles} cycles`);
		const dual = await runMatrix("two viewers", 1, root);

		// H1 lives here: contention should not change the shape of a stop.
		const singleWorst = Math.max(...single.map((s) => s.roundTripMs));
		const dualWorst = Math.max(...dual.map((s) => s.roundTripMs));
		console.log(`\n  worst round-trip: one viewer ${singleWorst} ms · two viewers ${dualWorst} ms`);
		check(
			dual.length === single.length,
			"a second attached viewer does not cut the cycle matrix short",
		);
	} finally {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// best-effort
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
