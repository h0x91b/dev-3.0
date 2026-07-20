#!/usr/bin/env bun
/**
 * Targeted integration test for the detached-PTY prototype, on the REAL Bun
 * runtime (vitest stubs the Bun global, so a live Bun.Terminal cannot run there
 * — mirrors the `test:pane-e2e` pattern). Run: `bun run test:proto-e2e`.
 *
 * Proves end-to-end: start → attach → set observable state → disconnect →
 * fresh client rediscovers + reattaches to the SAME live shell (PID + state
 * unchanged) → stop terminates the whole shell tree and removes all metadata.
 *
 * And proves the tracer NEVER invokes tmux: a `tmux` shim is placed first on
 * PATH; if any prototype code ever shelled out to tmux, the shim would create a
 * sentinel file. The sentinel must stay absent.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, stop } from "../launcher";
import { PtyProtoClient } from "../client";
import { isProcessAlive, readState } from "../state";

let failures = 0;
function check(condition: boolean, msg: string): void {
	if (condition) {
		console.log(`  ok   - ${msg}`);
	} else {
		failures++;
		console.error(`  FAIL - ${msg}`);
	}
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Accumulate decoded PTY output from a client; wait for a substring or regex. */
function makeSink(client: PtyProtoClient): {
	text: () => string;
	waitFor: (sub: string, timeoutMs?: number) => Promise<boolean>;
	waitForMatch: (re: RegExp, timeoutMs?: number) => Promise<RegExpExecArray | null>;
} {
	let buf = "";
	const dec = new TextDecoder();
	client.onOutput((bytes) => {
		buf += dec.decode(bytes, { stream: true });
	});
	return {
		text: () => buf,
		async waitFor(sub, timeoutMs = 5000) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (buf.includes(sub)) return true;
				await delay(30);
			}
			return false;
		},
		// Waits for a FULL regex match — avoids the race where a prefix ("TOKEN:")
		// has arrived but the trailing digits have not (the PTY also echoes the
		// typed command, so match on the expanded output, not the command line).
		async waitForMatch(re, timeoutMs = 5000) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const m = re.exec(buf);
				if (m) return m;
				await delay(30);
			}
			return null;
		},
	};
}

async function run(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "dev3-pty-proto-e2e-"));
	const protoDir = join(root, "meta");
	const shimDir = join(root, "shim");
	const sentinel = join(root, "tmux-was-invoked");
	mkdirSync(shimDir, { recursive: true });
	const shim = join(shimDir, "tmux");
	writeFileSync(shim, `#!/bin/sh\necho called >> "${sentinel}"\nexit 0\n`);
	chmodSync(shim, 0o755);

	// Isolate metadata, force a deterministic shell (no rc → no accidental tmux
	// auto-launch, no job control → grandchildren share the shell's pgroup), and
	// front-load the tmux shim on PATH for the host we're about to spawn.
	process.env.DEV3_PTY_PROTO_DIR = protoDir;
	process.env.DEV3_PTY_PROTO_CMD = JSON.stringify(["/bin/bash", "--norc", "--noprofile"]);
	process.env.PATH = `${shimDir}:${process.env.PATH ?? ""}`;

	const testPid = process.pid;

	// ── 1. start: a SEPARATE detached host owns one real shell ──
	const state = await start({ timeoutMs: 15_000 });
	check(state.hostPid > 0 && state.hostPid !== testPid, "launcher spawned a SEPARATE detached host process");
	check(isProcessAlive(state.hostPid), "host is alive after start() returned (launcher did not kill it)");
	check(state.shellPid > 0 && isProcessAlive(state.shellPid), "host owns a real live shell process");
	check(state.host === "127.0.0.1" && state.port > 0, "transport is loopback TCP on an ephemeral port");
	check(state.token.length > 0, "transport is guarded by a per-run token");

	const nonce = `state-${state.hostPid}-${state.shellPid}`;

	// ── 2. client 1: set observable shell state, spawn a grandchild, record PID ──
	const c1 = new PtyProtoClient();
	await c1.connect(state);
	const s1 = makeSink(c1);
	c1.input(`set +H\n`); // disable `!` history expansion so `$!` survives in an interactive shell
	c1.input(`export PROTO_STATE=${nonce}\n`);
	c1.input(`sleep 300 &\n`);
	c1.input(`echo "SLEEPPID[$!]"\n`);
	const sleepMatch = await s1.waitForMatch(/SLEEPPID\[(\d+)\]/);
	check(sleepMatch !== null, "client 1 receives live shell output");
	const sleepPid = Number(sleepMatch?.[1]);
	check(Number.isInteger(sleepPid) && isProcessAlive(sleepPid), "shell spawned a live grandchild process");
	const st1 = await c1.status();
	check(st1.shellPid === state.shellPid, "status over the wire reports the recorded shell PID");
	const recordedShellPid = st1.shellPid;
	c1.close();

	// ── 3. disconnect: host + shell survive with no client attached ──
	await delay(250);
	check(isProcessAlive(state.hostPid), "host survives client 1 disconnect");
	check(isProcessAlive(recordedShellPid), "shell survives client 1 disconnect");

	// ── 4. fresh client 2: rediscover endpoint + reattach to the SAME shell ──
	const discovered = readState();
	check(!!discovered && discovered.shellPid === recordedShellPid, "fresh client rediscovers the endpoint from metadata");
	const c2 = await PtyProtoClient.discover();
	const s2 = makeSink(c2);
	const st2 = await c2.status();
	check(st2.shellPid === recordedShellPid, "reattached client sees the UNCHANGED shell PID");
	check(st2.hostPid === state.hostPid, "reattached client sees the UNCHANGED host PID");
	c2.input(`echo "MARKER:$PROTO_STATE:$$"\n`);
	check(
		await s2.waitFor(`MARKER:${nonce}:${recordedShellPid}`),
		"reattached client proves shell STATE (env var) AND PID are preserved across reconnect",
	);
	c2.close();

	// ── 5. stop: terminate the whole shell tree + remove all metadata ──
	const stopped = await stop({ timeoutMs: 8000 });
	check(stopped, "stop() reports success");
	check(!isProcessAlive(state.hostPid), "host process terminated after stop");
	check(!isProcessAlive(recordedShellPid), "shell process terminated after stop");
	check(!isProcessAlive(sleepPid), "shell process TREE terminated (grandchild reaped)");
	check(readState() === null, "all prototype metadata removed after stop");
	check(!existsSync(join(protoDir, "state.json")), "state.json file removed from disk");

	// ── 6. the tracer never touched tmux ──
	check(!existsSync(sentinel), "tracer NEVER invoked tmux (PATH shim sentinel absent)");

	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		// best-effort
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
	.catch(async (err) => {
		console.error("\nERROR:", err);
		try {
			await stop({ timeoutMs: 3000 });
		} catch {
			// best-effort cleanup
		}
		process.exit(1);
	});
