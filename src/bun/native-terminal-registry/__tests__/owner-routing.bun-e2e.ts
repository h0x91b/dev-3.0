#!/usr/bin/env bun
/**
 * Cross-instance owner-routing E2E (seq 1381), on the REAL Bun runtime.
 * Run: `bun run test:native-owner-routing-e2e`.
 *
 * #1218 made a non-owning dev3 app process able to find out WHO holds a native
 * pane's writer lease and hand a whole delivery to that process. That path was
 * only ever proven by hand, and the units around it are mocked: the fake in
 * `native-pane-owner.test.ts` supplies the writer pid, and the WS bridge suite
 * runs one process. Neither can catch the failure that actually bit us — a
 * second app instance believing it may write, and the write going nowhere.
 *
 * So this drives THREE genuinely separate processes against one real host:
 *
 *   • controller A starts the session and takes the writer lease, then serves the
 *     CLI's NDJSON protocol on its own `<pid>.sock` and stays alive holding it;
 *   • controller B binds the SAME pane through the production
 *     `bindNativeTaskPane`, lands as an observer, reads the owner FROM THE HOST
 *     (not from app-side bookkeeping), and forwards one delivery to A;
 *   • controller C reopens as a fresh viewer, rediscovers from disk alone, and
 *     replays the journal to count what actually reached the PTY.
 *
 * What must hold: the delivery lands exactly ONCE and is performed by A; B's own
 * direct write never reaches the PTY; host/shell identity is untouched through
 * all three processes; no second host is spawned; and tmux is never invoked.
 *
 * Scope: additive test-only proof. No production behaviour changes.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "../../spawn";
import { isProcessAlive } from "../process-identity";
import { defineShellLaunchSpec, encodeShellLaunchSpec, NATIVE_SESSION_LAUNCH_ENV } from "../shell-launch";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) console.log(`  ok   - ${message}`);
	else {
		failures++;
		console.error(`  FAIL - ${message}`);
	}
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isWindows = process.platform === "win32";
const controllerEntry = fileURLToPath(new URL("./owner-routing-controller.ts", import.meta.url));
const JSON_SENTINEL = "__OWNER_ROUTING_JSON__";

type Verdict = Record<string, unknown> | null;

function extractVerdict(stdout: string): Verdict {
	for (const line of stdout.split("\n")) {
		if (line.startsWith(JSON_SENTINEL)) return JSON.parse(line.slice(JSON_SENTINEL.length)) as Verdict;
	}
	return null;
}

function num(verdict: Verdict, key: string): number {
	const value = verdict?.[key];
	return typeof value === "number" ? value : Number.NaN;
}

/**
 * A unix socket path must fit the platform's `sun_path` budget (104 bytes on
 * macOS), and the owner's socket lands at `<HOME>/.dev3.0/sockets/<pid>.sock`.
 * Keeping the temp root short is the whole reason for the terse prefix.
 */
function makeRoot(): string {
	return mkdtempSync(join(tmpdir(), "d3or-"));
}

async function run(): Promise<void> {
	const root = makeRoot();
	const home = join(root, "h");
	const metaDir = join(root, "meta");
	const shimDir = join(root, "shim");
	const sentinel = join(root, "tmux-was-invoked");
	mkdirSync(home, { recursive: true });
	mkdirSync(shimDir, { recursive: true });

	// Any tmux invocation anywhere in the three-process flow trips this sentinel.
	const shim = join(shimDir, isWindows ? "tmux.cmd" : "tmux");
	writeFileSync(
		shim,
		isWindows ? `@echo off\r\necho called>>"${sentinel}"\r\nexit /b 0\r\n` : `#!/bin/sh\necho called >> "${sentinel}"\nexit 0\n`,
	);
	if (!isWindows) chmodSync(shim, 0o755);

	const launch = defineShellLaunchSpec({
		executable: isWindows ? "powershell.exe" : "/bin/bash",
		argv: isWindows ? ["-NoLogo", "-NoProfile", "-NoExit"] : ["--norc", "--noprofile"],
		cwd: root,
		env: {},
	});

	const nonce = `${Date.now().toString(36)}`;
	const marker = `ROUTED-${nonce}`;
	const directMarker = `DIRECT-${nonce}`;
	const sessionId = `owner-routing-${nonce}`;

	const childEnv = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		DEV3_NATIVE_SESSIONS_DIR: metaDir,
		DEV3_OWNER_ROUTING_MARKER: marker,
		DEV3_OWNER_ROUTING_DIRECT_MARKER: directMarker,
		[NATIVE_SESSION_LAUNCH_ENV]: encodeShellLaunchSpec(launch),
		PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
	};

	/** Run a short-lived controller to completion and read its single verdict. */
	function runController(phase: string, ...args: string[]): { exitCode: number; verdict: Verdict; stderr: string } {
		const proc = spawnSync([process.execPath, controllerEntry, phase, sessionId, ...args], {
			env: childEnv,
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = new TextDecoder().decode(proc.stdout);
		const stderr = new TextDecoder().decode(proc.stderr);
		return { exitCode: proc.exitCode, verdict: extractVerdict(stdout), stderr };
	}

	let owner: ReturnType<typeof spawn> | null = null;
	try {
		// ── A: start the session, take the lease, stay alive holding it ──────────
		owner = spawn([process.execPath, controllerEntry, "own", sessionId], {
			env: childEnv,
			stdout: "pipe",
			stderr: "pipe",
		});
		const ownerVerdict = await readFirstVerdict(owner, 40_000);
		if (!ownerVerdict) throw new Error("controller A never published a verdict");

		const ownerPid = num(ownerVerdict, "pid");
		const hostPid = num(ownerVerdict, "hostPid");
		const shellPid = num(ownerVerdict, "shellPid");
		check(ownerVerdict.role === "writer", "the first app process holds the writer lease");
		check(typeof ownerVerdict.selfEndpoint === "string", "the owner publishes a peer socket other processes can find");
		check(isProcessAlive(hostPid) && isProcessAlive(shellPid), "the host and its shell are live before any peer attaches");

		// ── B: a second app process — observer, resolves the owner, forwards ─────
		const routed = runController("route", String(ownerPid));
		const route = routed.verdict;
		check(routed.exitCode === 0, `controller B exits cleanly${routed.exitCode === 0 ? "" : `\n${routed.stderr}`}`);
		check(route?.role === "observer", "a second app process binding the same pane lands as an OBSERVER");
		check(route?.ownerKind === "peer", "the owner is resolved as a peer process, not guessed as vacant or unknown");
		check(num(route, "ownerPid") === ownerPid, "the resolved owner is the process that actually holds the lease");
		check(typeof route?.ownerEndpoint === "string" && String(route.ownerEndpoint).includes(String(ownerPid)), "the peer is named precisely enough to forward to");
		// `null` is the honest "the host has not said" — a refused claim comes back
		// as an error frame, not an ownership frame, so nothing sets it. What must
		// never happen is `false`: that renders as "the slot is free" and invites a
		// claim while A is typing. pty-server only forwards a real boolean.
		check(route?.writerAttached !== false, "an observer is never told the writer slot is free while a peer holds it");
		check(route?.forwardError === null, `forwarding to the owner succeeds${route?.forwardError ? `: ${route.forwardError}` : ""}`);

		const forwarded = (route?.forwarded ?? {}) as Record<string, unknown>;
		check(forwarded.performedBy === ownerPid, "the delivery is performed by the OWNING process, not the caller");
		check(forwarded.performed === 1, "the owner performs the forwarded delivery exactly once");

		// Identity must be untouched by a peer attaching and routing through it.
		check(num(route, "hostPid") === hostPid, "the peer sees the SAME host pid — no second host was started");
		check(num(route, "shellPid") === shellPid, "the peer sees the SAME shell pid — no replacement shell was spawned");

		// ── C: reopen a second viewer — discovery, replay, and the byte count ────
		const observed = runController("observe");
		const observe = observed.verdict;
		check(observed.exitCode === 0, `controller C exits cleanly${observed.exitCode === 0 ? "" : `\n${observed.stderr}`}`);
		check(observe?.role === "observer", "a reopened viewer rediscovers the session and attaches as an observer");
		check(num(observe, "replayedBytes") > 0, "reopening the second viewer still replays the journal");
		check(num(observe, "markerCount") === 1, "the forwarded delivery reached pane-1 EXACTLY ONCE");
		check(num(observe, "directMarkerCount") === 0, "the non-owning process's own direct write never reached the PTY");
		check(num(observe, "hostPid") === hostPid && num(observe, "shellPid") === shellPid, "host and shell identity survive the whole three-process flow");

		// ── Global invariants ────────────────────────────────────────────────────
		check(isProcessAlive(hostPid) && isProcessAlive(shellPid), "the original host and shell are still alive at the end");
		check(sessionDirCount(metaDir) === 1, "exactly one native session exists on disk — no duplicate was created");
		check(!existsSync(sentinel), "the whole cross-process routing flow NEVER invokes tmux");
	} finally {
		if (owner) {
			try {
				owner.kill();
			} catch { /* best effort */ }
			await Promise.race([owner.exited, delay(5000)]);
		}
		// Stop the detached host from a clean process, then drop the temp root.
		spawnSync([process.execPath, controllerEntry, "stop", sessionId], { env: childEnv, stdout: "pipe", stderr: "pipe" });
		try {
			rmSync(root, { recursive: true, force: true });
		} catch { /* best effort */ }
	}
}

function sessionDirCount(metaDir: string): number {
	try {
		return readdirSync(metaDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
	} catch {
		return 0;
	}
}

/** Read the long-lived owner's single verdict off its stdout without ending it. */
async function readFirstVerdict(proc: ReturnType<typeof spawn>, timeoutMs: number): Promise<Verdict> {
	const stdout = proc.stdout as ReadableStream<Uint8Array> | undefined;
	if (!stdout) return null;
	const reader = stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const deadline = Date.now() + timeoutMs;
	try {
		while (Date.now() < deadline) {
			const next = await Promise.race([reader.read(), delay(deadline - Date.now()).then(() => null)]);
			if (!next || next.done) break;
			buffer += decoder.decode(next.value, { stream: true });
			const verdict = extractVerdict(buffer);
			if (verdict) return verdict;
		}
		return null;
	} finally {
		reader.releaseLock();
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
