#!/usr/bin/env bun
/**
 * Real-transport proof for the Linux launch handoff (issue #2039).
 *
 * The vitest suite proves the rules with an injected request; this script runs
 * the REAL `requestOverUnixSocket` client against REAL `startCliListener` Unix
 * listeners — under `bun`, because vitest runs on Node where `Bun.listen` does
 * not exist. Each listener plays one kind of running instance.
 *
 * Run: bun run test:launch-handoff-e2e
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCliListener, type CliListener } from "../cli-listener";
import { LAUNCH_ACTIVATE_METHOD, decideLaunchActivation, handOffToRunningInstance, requestOverUnixSocket } from "../launch-handoff";
import type { CliRequest, CliResponse } from "../../shared/types";

const BUNDLE = "/opt/dev3/Resources/app/views";

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) console.log(`  ok   - ${message}`);
	else {
		failures++;
		console.error(`  FAIL - ${message}`);
	}
}

type Peer = { listener: CliListener; actions: string[] };
const listeners: CliListener[] = [];

/** A running instance: `knowsMethod: false` is a build from before the handoff. */
function peer(socketsDir: string, pid: number, opts: { bundle?: string; hostTaskId?: string | null; windows?: number; knowsMethod?: boolean; hang?: boolean }): Peer {
	const actions: string[] = [];
	const listener = startCliListener({
		socketsDir,
		pid,
		hostTaskId: opts.hostTaskId ?? null,
		transport: "unix",
		handle: async (req: CliRequest): Promise<CliResponse> => {
			if (req.method !== LAUNCH_ACTIVATE_METHOD || opts.knowsMethod === false) return { id: req.id, ok: false, error: `Unknown method: ${req.method}` };
			if (opts.hang) await new Promise(() => {});
			const decision = decideLaunchActivation({
				platform: "linux",
				bundle: String(req.params.bundle),
				ownBundle: opts.bundle ?? BUNDLE,
				hostTaskId: opts.hostTaskId ?? null,
				windowCount: opts.windows ?? 0,
			});
			if (decision.activated) actions.push(decision.open ? "open-window" : "focus-window");
			return { id: req.id, ok: true, data: { activated: decision.activated, reason: decision.reason } };
		},
	});
	listeners.push(listener);
	return { listener, actions };
}

const handOff = (peers: string[]) => handOffToRunningInstance({ peers: () => peers, request: requestOverUnixSocket, bundle: BUNDLE });

async function run(): Promise<void> {
	const socketsDir = mkdtempSync(join(tmpdir(), "dev3-handoff-"));
	try {
		console.log("window-less primary of the same install");
		const orphan = peer(socketsDir, 101, { windows: 0 });
		check((await handOff([orphan.listener.endpoint])) === orphan.listener.endpoint, "the launch is taken over");
		check(orphan.actions.join() === "open-window", "the primary reopens a window (last window had been closed)");

		console.log("\nprimary that still has windows");
		const busy = peer(socketsDir, 102, { windows: 2 });
		check((await handOff([busy.listener.endpoint])) === busy.listener.endpoint, "the launch is taken over");
		check(busy.actions.join() === "focus-window", "an existing window is raised, no extra window");

		console.log("\ninstances that must not take over");
		const devBuild = peer(socketsDir, 103, { bundle: "/home/me/dev-3.0/build/views" });
		const guest = peer(socketsDir, 104, { hostTaskId: "task-uuid" });
		const older = peer(socketsDir, 105, { knowsMethod: false });
		check((await handOff([devBuild.listener.endpoint, guest.listener.endpoint, older.listener.endpoint])) === null, "a dev build, a guest and an older build all leave the launch alone");
		check(devBuild.actions.length + guest.actions.length === 0, "none of them opened anything");

		console.log("\na declining peer does not hide the real primary");
		const primary = peer(socketsDir, 106, { windows: 0 });
		check((await handOff([guest.listener.endpoint, primary.listener.endpoint])) === primary.listener.endpoint, "the second peer takes over");

		console.log("\nbroken peers fall back to a normal launch");
		const stale = join(socketsDir, "107.sock");
		writeFileSync(stale, "");
		let started = Date.now();
		check((await handOff([stale])) === null, "a stale socket file is skipped");
		check(Date.now() - started < 1000, `the stale socket costs no timeout (${Date.now() - started}ms)`);
		const hung = peer(socketsDir, 108, { hang: true });
		started = Date.now();
		check((await handOff([hung.listener.endpoint])) === null, "a hung peer does not block the launch forever");
		const waited = Date.now() - started;
		check(waited >= 1400 && waited < 3000, `the hung peer costs one bounded timeout (${waited}ms)`);
	} finally {
		for (const listener of listeners) {
			try { listener.stop(); } catch { /* already stopped */ }
		}
		rmSync(socketsDir, { recursive: true, force: true });
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
