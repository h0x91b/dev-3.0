#!/usr/bin/env bun

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { isProcessAlive } from "../process-identity";
import { readProcessStartSignature } from "../process-identity-native";
import {
	type SessionLockProcessEvidence,
	type SessionLockProcessEvidenceAdapter,
	SessionLockRuntime,
} from "../session-lock";
import { NATIVE_SESSIONS_DIR_ENV, NATIVE_SESSION_LOCKS_DIR_ENV, sessionLockFile } from "../paths";

const [role, root, deadPidText] = process.argv.slice(2);
if (!role || !root) throw new Error("usage: session-lock-worker.ts <D|B|C> <root> [dead-pid]");

process.env[NATIVE_SESSIONS_DIR_ENV] = join(root, "sessions");
process.env[NATIVE_SESSION_LOCKS_DIR_ENV] = join(root, "locks");

function barrier(name: string): void {
	writeSync(1, `${name}\n`);
}

function waitForParent(): void {
	readFileSync(0, "utf8");
}

async function realEvidence(pid: number): Promise<SessionLockProcessEvidence> {
	if (!isProcessAlive(pid)) return { status: "dead" };
	const startSignature = await readProcessStartSignature(pid);
	if (!isProcessAlive(pid)) return { status: "dead" };
	return { status: "alive", startSignature: startSignature || null };
}

const bInput = role === "B" ? Bun.stdin.stream().getReader() : null;
async function waitForSignal(): Promise<void> {
	const signal = await bInput?.read();
	if (!signal || signal.done) throw new Error("parent closed B's barrier stream");
}

const deadPid = Number(deadPidText);
let paused = false;
const processEvidence: SessionLockProcessEvidenceAdapter = {
	async inspect(pid) {
		const evidence = await realEvidence(pid);
		if (role === "B" && pid === deadPid && evidence.status === "dead" && !paused) {
			paused = true;
			barrier("stale-observed");
			await waitForSignal();
		}
		return evidence;
	},
};

let movedReported = false;
let blockedReported = false;
const runtime = new SessionLockRuntime(
	role === "B"
		? {
				afterCanonicalMovedToClaim: async ({ claimPath, movedGeneration }) => {
					if (movedReported) return;
					movedReported = true;
					barrier(`claim-moved:${movedGeneration ?? "invalid"}:${basename(claimPath)}`);
				},
				afterBlockingClaimScan: async ({ generations }) => {
					if (blockedReported) return;
					blockedReported = true;
					barrier(`claim-blocked:${generations.join(",")}`);
					await waitForSignal();
				},
			}
		: {},
);

const guard = join(root, "critical.guard");
await runtime.withSessionStateLock(
	"aba",
	() => {
		if (role === "D") {
			barrier("entered");
			waitForParent();
			return;
		}
		const fd = openSync(guard, "wx", 0o600);
		try {
			if (role === "C") {
				const canonical = JSON.parse(readFileSync(sessionLockFile("aba", "canonical"), "utf8")) as {
					generation?: string;
				};
				barrier(`entered:${canonical.generation ?? "invalid"}`);
			} else {
				barrier("entered");
			}
			if (role === "C") waitForParent();
		} finally {
			closeSync(fd);
			unlinkSync(guard);
		}
	},
	{
		processEvidence,
		staleAfterMs: 0,
		timeoutMs: 10_000,
		pollMs: 5,
	},
);
barrier("released");
