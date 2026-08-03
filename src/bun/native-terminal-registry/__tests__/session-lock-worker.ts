#!/usr/bin/env bun

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isProcessAlive } from "../process-identity";
import { readProcessStartSignature } from "../process-identity-native";
import {
	type SessionLockProcessEvidence,
	type SessionLockProcessEvidenceAdapter,
	withSessionStateLock,
} from "../session-lock";
import { NATIVE_SESSIONS_DIR_ENV, NATIVE_SESSION_LOCKS_DIR_ENV } from "../paths";

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

const deadPid = Number(deadPidText);
let paused = false;
const processEvidence: SessionLockProcessEvidenceAdapter = {
	async inspect(pid) {
		const evidence = await realEvidence(pid);
		if (role === "B" && pid === deadPid && evidence.status === "dead" && !paused) {
			paused = true;
			barrier("stale-observed");
			await new Response(Bun.stdin.stream()).text();
		}
		return evidence;
	},
};

const guard = join(root, "critical.guard");
await withSessionStateLock(
	"aba",
	() => {
		if (role === "D") {
			barrier("entered");
			waitForParent();
			return;
		}
		const fd = openSync(guard, "wx", 0o600);
		try {
			barrier("entered");
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
