#!/usr/bin/env bun
/**
 * Real-process proof for the ownership snapshot (seq 1293).
 *
 * The vitest unit tests prove the attribution RULES against injected evidence;
 * this script proves the same rules against the REAL scanners (`ps` + `lsof`) and
 * real processes — under `bun`, because vitest stubs `Bun.spawn`.
 *
 * Checks: a nested grandchild listener is attributed to its root, an unrelated
 * sentinel listener never is, and an exited tree owns nothing.
 *
 * Run: bun run test:ownership-e2e   (POSIX only — the scanners shell out)
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearProcessInfoCache, getDescendantPids, getLsofOutput } from "../../port-scanner";
import { spawn } from "../../spawn";
import { collectOwnershipSnapshot } from "../collector";
import { verifiedClaim } from "../contract";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) console.log(`  ok   - ${message}`);
	else {
		failures++;
		console.error(`  FAIL - ${message}`);
	}
}

const LISTENER = `
const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
console.log("PORT " + server.port);
setInterval(() => {}, 1000);
`;

type Listener = { pid: number; port: number };

const roots: number[] = [];

/** Read stdout until the listener announces its ephemeral port. */
async function readPort(stdout: ReadableStream<Uint8Array>, timeoutMs = 15_000): Promise<number> {
	const reader = stdout.getReader();
	const decoder = new TextDecoder();
	const deadline = Date.now() + timeoutMs;
	let buffered = "";
	try {
		while (Date.now() < deadline) {
			const { value, done } = await reader.read();
			if (done) break;
			buffered += decoder.decode(value, { stream: true });
			const match = buffered.match(/PORT (\d+)/);
			if (match) return Number(match[1]);
		}
	} finally {
		reader.releaseLock();
	}
	return 0;
}

/**
 * Start `sh → sh → bun listener`; the outer sh is the claimed root. The trailing
 * `; :` and the `& wait` stop each shell from `exec`ing its single command away,
 * which is what keeps the listener a genuine GRANDCHILD.
 */
async function startNestedListener(scriptPath: string): Promise<Listener> {
	const proc = spawn(["sh", "-c", 'sh -c "$BUN $SCRIPT & wait"; :'], {
		stdout: "pipe",
		stderr: "ignore",
		env: { BUN: process.execPath, SCRIPT: scriptPath },
	});
	roots.push(proc.pid);
	return { pid: proc.pid, port: proc.stdout ? await readPort(proc.stdout) : 0 };
}

/** A listener that is nobody's descendant — the negative control. */
async function startSentinelListener(scriptPath: string): Promise<Listener> {
	const proc = spawn([process.execPath, scriptPath], { stdout: "pipe", stderr: "ignore" });
	roots.push(proc.pid);
	return { pid: proc.pid, port: proc.stdout ? await readPort(proc.stdout) : 0 };
}

async function killTree(pid: number): Promise<void> {
	clearProcessInfoCache();
	for (const target of [...(await getDescendantPids(pid)), pid]) {
		try {
			process.kill(target, "SIGKILL");
		} catch {
			// already gone
		}
	}
}

async function run(): Promise<void> {
	if (process.platform === "win32") {
		console.log("SKIPPED — POSIX only (`ps` / `lsof` scanners)");
		return;
	}
	if ((await getLsofOutput()).length === 0) {
		console.error("`lsof` produced no output — cannot observe port attribution on this machine");
		failures++;
		return;
	}

	const workDir = mkdtempSync(join(tmpdir(), "dev3-ownership-"));
	const scriptPath = join(workDir, "listener.js");
	writeFileSync(scriptPath, LISTENER);

	try {
		console.log("\nnested listener + unrelated sentinel");
		const owned = await startNestedListener(scriptPath);
		const sentinel = await startSentinelListener(scriptPath);
		check(owned.port > 0, `nested listener came up on port ${owned.port}`);
		check(sentinel.port > 0, `sentinel listener came up on port ${sentinel.port}`);

		clearProcessInfoCache();
		const claim = verifiedClaim("native", "live-session", [{ pid: owned.pid, role: "host" }]);
		const snapshot = await collectOwnershipSnapshot(claim);
		const processes = snapshot.ownership.state === "owned" ? snapshot.ownership.processes : [];
		const ports = snapshot.ports.map((port) => port.port);

		check(snapshot.ownership.state === "owned", "ownership verified from the proved root");
		check(
			snapshot.coverage.descendants && snapshot.coverage.resources && snapshot.coverage.ports,
			"all three scanners reported coverage",
		);
		check(
			processes.filter((process) => process.role === "descendant").length >= 2,
			"the nested shell and the listener are attributed as descendants",
		);
		check(ports.includes(owned.port), "the nested listener's port is in the snapshot");
		check(!ports.includes(sentinel.port), "the unrelated sentinel's port is NOT in the snapshot");
		check(!processes.some((process) => process.pid === sentinel.pid), "the sentinel process is NOT attributed");
		check((snapshot.resources?.rss ?? 0) > 0, "resource cost aggregated for the owned tree");

		console.log("\nexited tree");
		await killTree(owned.pid);
		clearProcessInfoCache();
		const afterExit = await collectOwnershipSnapshot(claim);
		const exitedPorts = afterExit.ports.map((port) => port.port);
		check(!exitedPorts.includes(owned.port), "the dead tree's port is gone from the snapshot");
		check(afterExit.resources?.rss === 0, "the dead tree costs nothing");
	} finally {
		for (const pid of roots) await killTree(pid);
		rmSync(workDir, { recursive: true, force: true });
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
