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
	isSessionLockGeneration,
	parseSessionLockFile,
	sessionLockFile,
	sessionLocksRootDir,
	tokenFile,
} from "./paths";

const SESSION_LOCK_VERSION = 1 as const;
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
		!isSessionLockGeneration(record.generation) ||
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

interface SessionLockFamilyFile {
	path: string;
	member: "canonical" | "candidate" | "claim";
}

async function familyFiles(sessionId: string): Promise<SessionLockFamilyFile[]> {
	let entries: string[];
	try {
		entries = await readdir(sessionLocksRootDir());
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}
	const family: SessionLockFamilyFile[] = [];
	for (const entry of entries) {
		const identity = parseSessionLockFile(entry);
		if (identity?.sessionId !== sessionId) continue;
		family.push({ path: join(sessionLocksRootDir(), entry), member: identity.member });
	}
	return family;
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

interface BlockingClaim {
	path: string;
	generation: string | null;
}

async function collectStaleNoncanonical(sessionId: string, options: ResolvedLockOptions): Promise<BlockingClaim[]> {
	const blockingClaims: BlockingClaim[] = [];
	for (const familyFile of await familyFiles(sessionId)) {
		if (familyFile.member === "canonical") continue;
		const inspection = await inspectLockFile(familyFile.path);
		if (inspection.kind === "absent") continue;
		if (inspection.kind === "invalid") {
			if (familyFile.member === "claim") blockingClaims.push({ path: familyFile.path, generation: null });
			continue;
		}
		const stale = staleByAge(inspection.record, options) && (await staleByEvidence(inspection.record, options));
		if (stale) await unlinkIfGeneration(familyFile.path, inspection.record.generation);
		else if (familyFile.member === "claim") {
			blockingClaims.push({ path: familyFile.path, generation: inspection.record.generation });
		}
	}
	return blockingClaims;
}

/** Internal dependency seam for deterministic filesystem race barriers. */
export interface SessionLockRuntimeHooks {
	afterClaimScanBeforeCanonicalLink?: (sessionId: string) => Promise<void>;
	beforeRollbackCanonicalRetirement?: (details: { sessionId: string; generation: string }) => Promise<void>;
	afterBlockingClaimScan?: (details: {
		sessionId: string;
		generations: Array<string | null>;
	}) => Promise<void>;
	afterCanonicalMovedToClaim?: (details: {
		sessionId: string;
		claimPath: string;
		movedGeneration: string | null;
	}) => Promise<void>;
}

async function claimStaleCanonical(
	sessionId: string,
	observed: SessionLockRecord,
	contenderGeneration: string,
	options: ResolvedLockOptions,
	hooks: SessionLockRuntimeHooks,
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
	await hooks.afterCanonicalMovedToClaim?.({
		sessionId,
		claimPath: claim,
		movedGeneration: moved.kind === "record" ? moved.record.generation : null,
	});
	if (moved.kind !== "record" || moved.record.generation !== observed.generation) return;
	if (!staleByAge(moved.record, options) || !(await staleByEvidence(moved.record, options))) return;
	await unlinkIfGeneration(claim, moved.record.generation);
}

async function retireCanonicalAfterRollback(
	sessionId: string,
	generation: string,
	hooks: SessionLockRuntimeHooks,
): Promise<void> {
	await hooks.beforeRollbackCanonicalRetirement?.({ sessionId, generation });
	const canonical = sessionLockFile(sessionId, "canonical");
	const rollbackClaim = sessionLockFile(sessionId, "claim", randomBytes(32).toString("hex"));
	try {
		await rename(canonical, rollbackClaim);
	} catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "EEXIST") return;
		throw error;
	}
	const moved = await inspectLockFile(rollbackClaim);
	if (moved.kind !== "record" || moved.record.generation !== generation) return;
	await unlinkIfGeneration(rollbackClaim, generation);
}

async function acquire(
	sessionId: string,
	record: SessionLockRecord,
	options: ResolvedLockOptions,
	hooks: SessionLockRuntimeHooks,
): Promise<void> {
	const candidate = sessionLockFile(sessionId, "candidate", record.generation);
	const canonical = sessionLockFile(sessionId, "canonical");
	const deadline = Date.now() + options.timeoutMs;
	for (;;) {
		const blockingClaims = await collectStaleNoncanonical(sessionId, options);
		if (blockingClaims.length > 0 && blockingClaims.every((claim) => claim.generation === record.generation)) {
			await unlinkIfGeneration(candidate, record.generation);
			return;
		}
		if (blockingClaims.length > 0) {
			await hooks.afterBlockingClaimScan?.({
				sessionId,
				generations: blockingClaims.map((claim) => claim.generation),
			});
		}
		if (blockingClaims.length === 0) {
			await hooks.afterClaimScanBeforeCanonicalLink?.(sessionId);
			try {
				await link(candidate, canonical);
				// A foreign claim that freed the canonical name necessarily exists before
				// this link can succeed. This post-link scan is therefore the acquisition
				// barrier; a claim that appears later can only contain our own generation.
				const postLinkClaims = await collectStaleNoncanonical(sessionId, options);
				if (
					postLinkClaims.length === 0 ||
					postLinkClaims.every((claim) => claim.generation === record.generation)
				) {
					await unlink(candidate);
					return;
				}
				await retireCanonicalAfterRollback(sessionId, record.generation, hooks);
			} catch (error) {
				if (errorCode(error) !== "EEXIST") throw error;
			}
			const current = await inspectLockFile(canonical);
			if (
				current.kind === "record" &&
				staleByAge(current.record, options) &&
				(await staleByEvidence(current.record, options))
			) {
				await claimStaleCanonical(sessionId, current.record, record.generation, options, hooks);
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
	for (const familyFile of await familyFiles(sessionId)) await unlinkIfGeneration(familyFile.path, generation);
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
	hooks: SessionLockRuntimeHooks = {},
): Promise<T> {
	assertValidSessionId(sessionId);
	const resolved = resolveOptions(options);
	const owner = await createCandidate(sessionId, resolved);
	let acquired = false;
	let hasCallbackError = false;
	let callbackError: unknown;
	let value: T | undefined;
	try {
		await acquire(sessionId, owner, resolved, hooks);
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

export class SessionLockRuntime {
	constructor(private readonly hooks: SessionLockRuntimeHooks = {}) {}

	withSessionStateLock<T>(sessionId: string, critical: () => T, options: SessionStateLockOptions = {}): Promise<T> {
		return runWithSessionStateLock(sessionId, critical, options, this.hooks);
	}

	withOwnedSessionState<T>(
		sessionId: string,
		expectedToken: string,
		critical: () => T,
		options: SessionStateLockOptions = {},
	): Promise<OwnedSessionMutation<T>> {
		return this.withSessionStateLock(sessionId, () => {
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
}

const defaultSessionLockRuntime = new SessionLockRuntime();

export const withSessionStateLock = defaultSessionLockRuntime.withSessionStateLock.bind(defaultSessionLockRuntime);
export const withOwnedSessionState = defaultSessionLockRuntime.withOwnedSessionState.bind(defaultSessionLockRuntime);
