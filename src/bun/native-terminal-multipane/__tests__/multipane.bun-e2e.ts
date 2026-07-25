#!/usr/bin/env bun
/**
 * Real-runtime multi-pane coordinator proof (seq 1283).
 *
 * Creates 2 and then 6 REAL panes — each its own registry-owned host and shell —
 * exercises split / directional focus / client-local zoom / writer-owned resize /
 * close, detaches, reconnects from a genuinely FRESH controller process, and
 * tears everything down. Never touches tmux (proved by a PATH shim sentinel).
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listPaneIds } from "../../../shared/split-tree";
import { isProcessAlive } from "../../native-terminal-registry/process-identity";
import { readRecord } from "../../native-terminal-registry/record";
import { defineShellLaunchSpec, type ShellLaunchSpec } from "../../native-terminal-registry/shell-launch";
import { spawn } from "../../spawn";
import { NativeMultipaneCoordinator, type PaneConnection, type PaneLaunchSpec } from "../coordinator";
import { ObserverMutationError } from "../errors";
import { directionalFocusTarget } from "../focus-mapping";
import { NATIVE_MULTIPANE_DIR_ENV, coordinatorRecordFile, paneSessionId } from "../paths";
import { readMultipaneRecord } from "../record";

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
const COORDINATOR_ID = "mpe2e";

function makeSink(connection: PaneConnection): { text: () => string; waitFor: (needle: string) => Promise<boolean> } {
	let output = "";
	const waiters: Array<{ needle: string; resolve: (matched: boolean) => void }> = [];
	const decoder = new TextDecoder();
	connection.onOutput((bytes) => {
		output += decoder.decode(bytes, { stream: true });
		for (let index = waiters.length - 1; index >= 0; index--) {
			const waiter = waiters[index]!;
			if (!output.includes(waiter.needle)) continue;
			waiters.splice(index, 1);
			waiter.resolve(true);
		}
	});
	return {
		text: () => output,
		waitFor(needle) {
			if (output.includes(needle)) return Promise.resolve(true);
			return new Promise((resolve) => waiters.push({ needle, resolve }));
		},
	};
}

/** Poll `probe` until it yields a value, or give up and return null. */
async function waitFor<T>(probe: () => T | null, timeoutMs = 5000): Promise<T | null> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== null) return value;
		if (Date.now() >= deadline) return null;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** Echo the pane's own env marker plus the shell's real pid — proof of independence. */
function identityCommand(): string {
	if (isWindows) return 'Write-Output ("PANE-" + $env:DEV3_NATIVE_PANE_ID + "-" + $PID)';
	return 'printf "PANE-%s-%s\\n" "$DEV3_NATIVE_PANE_ID" "$$"';
}

function launchSpec(root: string, paneId: string): PaneLaunchSpec {
	const base: ShellLaunchSpec = isWindows
		? { executable: "powershell.exe", argv: ["-NoLogo", "-NoProfile", "-NoExit"], cwd: root, env: {} }
		: { executable: "/bin/bash", argv: ["--norc", "--noprofile"], cwd: root, env: {} };
	return {
		launch: defineShellLaunchSpec({ ...base, env: { ...base.env, DEV3_NATIVE_PANE_ID: paneId } }),
		cols: 80,
		rows: 24,
		timeoutMs: 20_000,
	};
}

async function growTo(
	coordinator: NativeMultipaneCoordinator,
	root: string,
	target: number,
): Promise<void> {
	let last = coordinator.paneIds()[coordinator.paneIds().length - 1]!;
	while (coordinator.paneIds().length < target) {
		const index = coordinator.paneIds().length;
		last = await coordinator.split(
			last,
			index % 2 === 1 ? "horizontal" : "vertical",
			launchSpec(root, `pane-${index + 1}`),
		);
	}
}

function cliEntry(): string {
	return fileURLToPath(new URL("../cli.ts", import.meta.url));
}

/** A genuinely fresh controller: a separate process that only reads disk state. */
async function freshControllerList(): Promise<string> {
	const proc = spawn([process.execPath, cliEntry(), "list", COORDINATOR_ID], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	if (proc.exitCode !== 0) throw new Error(`fresh controller failed: ${stderr || stdout}`);
	return stdout;
}

async function run(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "dev3-multipane-e2e-"));
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

	let coordinator: NativeMultipaneCoordinator | null = null;
	try {
		console.log("\n# two real panes");
		coordinator = await NativeMultipaneCoordinator.create(COORDINATOR_ID, launchSpec(root, "pane-1"));
		await growTo(coordinator, root, 2);
		const twoPanes = await coordinator.listPanes();
		check(twoPanes.length === 2, "two logical panes exist");
		check(
			new Set(twoPanes.map((pane) => pane.hostPid)).size === 2 &&
				new Set(twoPanes.map((pane) => pane.shellPid)).size === 2,
			"each logical pane owns its own host process and shell process",
		);
		check(
			twoPanes.every((pane) => pane.state === "running" && isProcessAlive(pane.shellPid)),
			"both pane shells are live and ownership-verified",
		);
		for (const pane of twoPanes) {
			console.log(`  pane ${pane.paneId} session=${pane.sessionId} hostPid=${pane.hostPid} shellPid=${pane.shellPid}`);
		}

		const sinks = new Map<string, ReturnType<typeof makeSink>>();
		for (const pane of twoPanes) {
			const connection = await coordinator.connect(pane.paneId);
			sinks.set(pane.paneId, makeSink(connection));
			await coordinator.writePane(pane.paneId, `${identityCommand()}${lineEnd}`);
		}
		for (const pane of twoPanes) {
			await sinks.get(pane.paneId)!.waitFor(`PANE-${pane.paneId}-`);
		}
		check(
			twoPanes.every((pane) => sinks.get(pane.paneId)!.text().includes(`PANE-${pane.paneId}-${pane.shellPid}`)),
			"each pane's shell reports its own env marker and its own pid",
		);
		check(
			!sinks.get("pane-1")!.text().includes("PANE-pane-2-") && !sinks.get("pane-2")!.text().includes("PANE-pane-1-"),
			"pane output streams never cross",
		);

		console.log("\n# client-local focus and zoom");
		const viewA = coordinator.attachClient("view-a");
		const viewB = coordinator.attachClient("view-b");
		viewA.focus("pane-1");
		viewA.focusDirection(coordinator.layout, "right");
		viewA.toggleZoom();
		check(viewA.focusedPaneId === "pane-2", "directional focus follows the shared geometry");
		check(
			viewB.focusedPaneId === "pane-1" && viewB.zoomedPaneId === null,
			"the second client keeps its own focus and stays unzoomed",
		);
		check(
			coordinator.layout.zoomedPaneId === null && coordinator.layout.activePaneId === "pane-1",
			"client focus and zoom never leak into the shared layout",
		);

		console.log("\n# writer-owned resize vs observer");
		await coordinator.resizePane("pane-1", 111, 41);
		// The host republishes its record after applying the resize, so poll rather
		// than assume the write already landed.
		const resized = await waitFor(() => {
			const record = readRecord(paneSessionId(COORDINATOR_ID, "pane-1"));
			return record?.cols === 111 && record?.rows === 41 ? record : null;
		});
		check(resized !== null, "the writer resizes its pane's PTY");

		const observerController = await NativeMultipaneCoordinator.recover(COORDINATOR_ID);
		check(observerController !== null, "a second controller observes the same live pane set");
		let observerRejected = false;
		try {
			await observerController!.resizePane("pane-1", 20, 5);
		} catch (error) {
			observerRejected = error instanceof ObserverMutationError;
		}
		const afterObserver = readRecord(paneSessionId(COORDINATOR_ID, "pane-1"));
		check(observerRejected, "an observer attachment refuses to resize the PTY");
		check(afterObserver?.cols === 111 && afterObserver?.rows === 41, "the observer left the PTY dimensions untouched");
		check(
			observerController!.paneIds().join(",") === coordinator.paneIds().join(","),
			"both controllers observe the same shared pane membership",
		);
		observerController!.detach();

		console.log("\n# detach and reconnect from a fresh controller process");
		coordinator.detach();
		const listing = await freshControllerList();
		console.log(listing.trimEnd().split("\n").map((line) => `    ${line}`).join("\n"));
		check(
			twoPanes.every((pane) => listing.includes(`hostPid=${pane.hostPid}`) && listing.includes(`shellPid=${pane.shellPid}`)),
			"a fresh controller process recovers the same host and shell pids",
		);
		check(
			twoPanes.every((pane) => listing.includes(`${pane.paneId}\tsession=${pane.sessionId}`)),
			"a fresh controller process recovers the same logical pane ids and bindings",
		);
		const afterReconnect = await coordinator.listPanes();
		check(
			JSON.stringify(afterReconnect) === JSON.stringify(twoPanes.map((p) => (p.paneId === "pane-1" ? { ...p, cols: 111, rows: 41 } : p))),
			"reconnecting spawned nothing: identical panes, only the writer's resize applied",
		);

		console.log("\n# six real panes");
		await growTo(coordinator, root, 6);
		const sixPanes = await coordinator.listPanes();
		check(sixPanes.length === 6, "six logical panes exist");
		check(new Set(sixPanes.map((pane) => pane.shellPid)).size === 6, "all six panes own distinct shells");
		check(
			listPaneIds(coordinator.layout).join(",") === readMultipaneRecord(COORDINATOR_ID)?.panes.map((p) => p.paneId).join(","),
			"the persisted record agrees with the in-memory layout",
		);
		const gridTargets = listPaneIds(coordinator.layout).map((paneId) => directionalFocusTarget(coordinator!.layout, paneId, "up"));
		check(
			gridTargets.every((target) => listPaneIds(coordinator!.layout).includes(target)),
			"directional focus resolves inside the six-pane geometry",
		);

		console.log("\n# closing one pane");
		const victim = sixPanes[2]!;
		const survivors = sixPanes.filter((pane) => pane.paneId !== victim.paneId);
		const closed = await coordinator.closePane(victim.paneId);
		check(!closed.sessionTornDown && closed.remainingPaneIds.length === 5, "closing a pane leaves the session alive");
		check(!isProcessAlive(victim.shellPid) && !isProcessAlive(victim.hostPid), "the closed pane's owned process tree is gone");
		check(
			survivors.every((pane) => isProcessAlive(pane.shellPid)),
			"every other pane's process tree survives untouched",
		);
		check(
			readMultipaneRecord(COORDINATOR_ID)?.panes.every((pane) => pane.paneId !== victim.paneId) === true,
			"the persisted layout reconciles the closed pane away",
		);

		console.log("\n# cleanup");
		const remaining = await coordinator.listPanes();
		await coordinator.cleanup();
		await coordinator.cleanup();
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && remaining.some((pane) => isProcessAlive(pane.shellPid))) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		check(
			remaining.every((pane) => !isProcessAlive(pane.shellPid) && !isProcessAlive(pane.hostPid)),
			"cleanup tears down every owned pane process tree",
		);
		check(!existsSync(coordinatorRecordFile(COORDINATOR_ID)), "cleanup removes the coordinator record");
		check((await NativeMultipaneCoordinator.recover(COORDINATOR_ID)) === null, "repeated cleanup and recovery are safe");
		check(!existsSync(sentinel), "the complete multi-pane lifecycle NEVER invokes tmux");
	} finally {
		try {
			await coordinator?.cleanup();
		} catch {
			// best-effort cleanup
		}
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
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
