/**
 * Generation-owned cross-process serialization for one native session's state.
 * Acquisition is async; the bounded critical callback is deliberately sync.
 */

import { constants, readFileSync } from "node:fs";
import { link, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { isProcessAlive, startSignaturesMatch } from "./process-identity";
import { readProcessStartSignature } from "./process-identity-native";
import {
	assertValidSessionId,
	sessionLockFile,
	sessionLocksRootDir,
	tokenFile,
} from "./paths";

const SESSION_LOCK_VERSION = 1 as const;
const GENERATION_PATTERN = /^[0-9a-f]{64}$/;
const MAX_LOCK_RECORD_BYTES = 4096;
const DEFAULT_STALE_AFTER_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_MS = 5;

interface SessionLockRecord {
	version: typeof SESSION_LOCK_VERSION;
	generation: string;
	pid: number;
	startSignature: string;
	createdAtMs: number;
}

export type SessionLockProcessEvidence =
	| { status: "alive"; startSignature: string | null }
	| { status: "dead" }
	| { status: "unknown" };

export interface SessionLockProcessEvidenceAdapter {
	inspect(pid: number): Promise<SessionLockProcessEvidence>;
}

export interface SessionStateLockOptions {
	processEvidence?: SessionLockProcessEvidenceAdapter;
	staleAfterMs?: number;
	timeoutMs?: number;
	pollMs?: number;
}

export type OwnedSessionMutation<T> =
	| { kind: "applied"; value: T }
	| { kind: "session-replaced" };

export class SessionLockTimeoutError extends Error {
	constructor(
		readonly sessionId: string,
		readonly timeoutMs = DEFAULT_TIMEOUT_MS,
	) {
		super(`could not acquire the state lock for session ${sessionId} within ${timeoutMs}ms`);
		this.name = "SessionLockTimeoutError";
	}
}

let ownStartSignature: Promise<string> | null = null;

const realProcessEvidence: SessionLockProcessEvidenceAdapter = {
	async inspect(pid): Promise<SessionLockProcessEvidence> {
		if (!isProcessAlive(pid)) return { status: "dead" };
		const startSignature =
			pid === process.pid
				? await (ownStartSignature ??= readProcessStartSignature(pid))
				: await readProcessStartSignature(pid);
		if (!isProcessAlive(pid)) return { status: "dead" };
		return { status: "alive", startSignature: startSignature || null };
	},
};

interface ResolvedLockOptions {
	processEvidence: SessionLockProcessEvidenceAdapter;
	staleAfterMs: number;
	timeoutMs: number;
	pollMs: number;
}

function resolveOptions(options: SessionStateLockOptions): ResolvedLockOptions {
	return {
		processEvidence: options.processEvidence ?? realProcessEvidence,
		staleAfterMs: options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		pollMs: options.pollMs ?? DEFAULT_POLL_MS,
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}

function parseLockRecord(text: string): SessionLockRecord | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (
		record.version !== SESSION_LOCK_VERSION ||
		typeof record.generation !== "string" ||
		!GENERATION_PATTERN.test(record.generation) ||
		typeof record.pid !== "number" ||
		!Number.isInteger(record.pid) ||
		record.pid <= 0 ||
		typeof record.startSignature !== "string" ||
		typeof record.createdAtMs !== "number" ||
		!Number.isFinite(record.createdAtMs) ||
		record.createdAtMs < 0
	) {
		return null;
	}
	return record as unknown as SessionLockRecord;
}

async function inspectLockFile(path: string): Promise<{ kind: "absent" } | { kind: "invalid" } | { kind: "record"; record: SessionLockRecord }> {
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { kind: "absent" };
		throw error;
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > MAX_LOCK_RECORD_BYTES) return { kind: "invalid" };
		const text = await handle.readFile({ encoding: "utf8" });
		const record = parseLockRecord(text);
		return record ? { kind: "record", record } : { kind: "invalid" };
	} finally {
		await handle.close();
	}
}

function serializeLockRecord(record: SessionLockRecord): string {
	return `${JSON.stringify(record)}\n`;
}

async function createCandidate(sessionId: string, options: ResolvedLockOptions): Promise<SessionLockRecord> {
	const generation = randomBytes(32).toString("hex");
	const evidence = await options.processEvidence.inspect(process.pid);
	if (evidence.status === "dead" || evidence.status === "unknown") {
		throw new Error(`cannot establish process evidence for session-state lock owner ${process.pid}`);
	}
	const record: SessionLockRecord = {
		version: SESSION_LOCK_VERSION,
		generation,
		pid: process.pid,
		startSignature: evidence.startSignature ?? "",
		createdAtMs: Date.now(),
	};
	await mkdir(sessionLocksRootDir(), { recursive: true, mode: 0o700 });
	const candidate = sessionLockFile(sessionId, "candidate", generation);
	let created = false;
	try {
		const handle = await open(candidate, "wx", 0o600);
		created = true;
		try {
			await handle.writeFile(serializeLockRecord(record), "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (created) await unlink(candidate).catch(() => {});
		throw error;
	}
	return record;
}

async function familyFiles(sessionId: string): Promise<string[]> {
	let entries: string[];
	try {
		entries = await readdir(sessionLocksRootDir());
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}
	const escapedSessionId = sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const familyPattern = new RegExp(
		`^${escapedSessionId}\\.(?:canonical|(?:candidate|claim)\\.[0-9a-f]{64})\\.lock$`,
	);
	return entries
		.filter((entry) => familyPattern.test(entry))
		.map((entry) => join(sessionLocksRootDir(), entry));
}

function staleByAge(record: SessionLockRecord, options: ResolvedLockOptions): boolean {
	return Date.now() - record.createdAtMs > options.staleAfterMs;
}

async function staleByEvidence(record: SessionLockRecord, options: ResolvedLockOptions): Promise<boolean> {
	const evidence = await options.processEvidence.inspect(record.pid);
	if (evidence.status === "dead") return true;
	if (evidence.status === "unknown" || evidence.startSignature === null || record.startSignature === "") return false;
	return !startSignaturesMatch(record.startSignature, evidence.startSignature);
}

async function unlinkIfGeneration(path: string, generation: string): Promise<void> {
	const inspection = await inspectLockFile(path);
	if (inspection.kind !== "record" || inspection.record.generation !== generation) return;
	try {
		await unlink(path);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

async function collectStaleNoncanonical(sessionId: string, options: ResolvedLockOptions): Promise<boolean> {
	let blockingClaim = false;
	for (const path of await familyFiles(sessionId)) {
		const name = path.slice(path.lastIndexOf("/") + 1);
		if (name === `${sessionId}.canonical.lock`) continue;
		const isClaim = name.startsWith(`${sessionId}.claim.`);
		const inspection = await inspectLockFile(path);
		if (inspection.kind === "absent") continue;
		if (inspection.kind === "invalid") {
			if (isClaim) blockingClaim = true;
			continue;
		}
		const stale = staleByAge(inspection.record, options) && (await staleByEvidence(inspection.record, options));
		if (stale) await unlinkIfGeneration(path, inspection.record.generation);
		else if (isClaim) blockingClaim = true;
	}
	return blockingClaim;
}

async function claimStaleCanonical(
	sessionId: string,
	observed: SessionLockRecord,
	contenderGeneration: string,
	options: ResolvedLockOptions,
): Promise<void> {
	const canonical = sessionLockFile(sessionId, "canonical");
	const claim = sessionLockFile(sessionId, "claim", contenderGeneration);
	try {
		await rename(canonical, claim);
	} catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "EEXIST") return;
		throw error;
	}
	const moved = await inspectLockFile(claim);
	if (moved.kind !== "record" || moved.record.generation !== observed.generation) return;
	if (!staleByAge(moved.record, options) || !(await staleByEvidence(moved.record, options))) return;
	await unlinkIfGeneration(claim, moved.record.generation);
}

async function acquire(
	sessionId: string,
	record: SessionLockRecord,
	options: ResolvedLockOptions,
): Promise<void> {
	const candidate = sessionLockFile(sessionId, "candidate", record.generation);
	const canonical = sessionLockFile(sessionId, "canonical");
	const deadline = Date.now() + options.timeoutMs;
	for (;;) {
		const claimBlocks = await collectStaleNoncanonical(sessionId, options);
		if (!claimBlocks) {
			try {
				await link(candidate, canonical);
				await unlink(candidate);
				return;
			} catch (error) {
				if (errorCode(error) !== "EEXIST") throw error;
			}
			const current = await inspectLockFile(canonical);
			if (
				current.kind === "record" &&
				staleByAge(current.record, options) &&
				(await staleByEvidence(current.record, options))
			) {
				await claimStaleCanonical(sessionId, current.record, record.generation, options);
				continue;
			}
		}
		if (Date.now() >= deadline) throw new SessionLockTimeoutError(sessionId, options.timeoutMs);
		await delay(options.pollMs);
	}
}

async function retireGeneration(sessionId: string, generation: string): Promise<void> {
	const canonical = sessionLockFile(sessionId, "canonical");
	const current = await inspectLockFile(canonical);
	if (current.kind === "record" && current.record.generation === generation) {
		const releaseClaim = sessionLockFile(sessionId, "claim", randomBytes(32).toString("hex"));
		try {
			await rename(canonical, releaseClaim);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
		await unlinkIfGeneration(releaseClaim, generation);
	}
	for (const path of await familyFiles(sessionId)) await unlinkIfGeneration(path, generation);
}

function ensureSynchronous<T>(value: T): T {
	if (value && typeof (value as { then?: unknown }).then === "function") {
		throw new Error("session-state lock critical callbacks must be synchronous");
	}
	return value;
}

function combineErrors(primary: unknown, releaseError: unknown): never {
	throw new AggregateError([primary, releaseError], "session-state callback and generation release both failed");
}

async function runWithSessionStateLock<T>(
	sessionId: string,
	critical: () => T,
	options: SessionStateLockOptions = {},
): Promise<T> {
	assertValidSessionId(sessionId);
	const resolved = resolveOptions(options);
	const owner = await createCandidate(sessionId, resolved);
	let acquired = false;
	let hasCallbackError = false;
	let callbackError: unknown;
	let value: T | undefined;
	try {
		await acquire(sessionId, owner, resolved);
		acquired = true;
		try {
			value = ensureSynchronous(critical());
		} catch (error) {
			hasCallbackError = true;
			callbackError = error;
		}
	} catch (error) {
		hasCallbackError = true;
		callbackError = error;
	}
	try {
		await retireGeneration(sessionId, owner.generation);
	} catch (releaseError) {
		if (hasCallbackError) combineErrors(callbackError, releaseError);
		throw releaseError;
	}
	if (hasCallbackError) throw callbackError;
	if (!acquired) throw new Error(`session-state lock acquisition for ${sessionId} ended without ownership`);
	return value as T;
}

export async function withSessionStateLock<T>(
	sessionId: string,
	critical: () => T,
	options: SessionStateLockOptions = {},
): Promise<T> {
	return runWithSessionStateLock(sessionId, critical, options);
}

export async function withOwnedSessionState<T>(
	sessionId: string,
	expectedToken: string,
	critical: () => T,
	options: SessionStateLockOptions = {},
): Promise<OwnedSessionMutation<T>> {
	return withSessionStateLock(sessionId, () => {
		let token: string | null;
		try {
			token = readFileSync(tokenFile(sessionId), "utf8").trim() || null;
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
			token = null;
		}
		if (token !== expectedToken) return { kind: "session-replaced" };
		return { kind: "applied", value: ensureSynchronous(critical()) };
	}, options);
}
