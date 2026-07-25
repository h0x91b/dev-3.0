/**
 * Versioned coordinator/layout record for the native multi-pane coordinator
 * (seq 1283).
 *
 * MINIMAL BY DESIGN: the record holds only what a fresh controller cannot
 * rediscover on its own — the coordinator id, its epoch, the serialized shared
 * `SplitTree`, and the logical-pane → registry-session binding. Everything else
 * (host pid, shell pid, endpoint, ownership evidence, PTY size) already lives in
 * the per-pane registry record and is read from there, never duplicated here.
 *
 * OWNERSHIP-SAFE WRITES: publication is tmp-write + rename, so a reader never
 * sees a torn file, and removal is a compare-and-swap on `epoch` — a stale
 * controller can never erase a coordinator that was torn down and recreated
 * under the same id.
 *
 * COMPATIBILITY: parse returns null for anything whose schemaVersion is not
 * exactly this build's — a newer record is unreadable-and-not-ours, never
 * migrated in place.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { listPaneIds, restoreSplitTree, type SplitTree } from "../../shared/split-tree";
import { isValidSessionId } from "../native-terminal-registry/paths";
import { coordinatorDir, coordinatorRecordFile, isValidCoordinatorId, multipaneRootDir } from "./paths";

export const NATIVE_MULTIPANE_SCHEMA_VERSION = 1 as const;

/** One logical pane bound to exactly one registry-owned PTY host. */
export interface MultipanePaneEntry {
	paneId: string;
	sessionId: string;
}

export interface NativeMultipaneRecord {
	schemaVersion: typeof NATIVE_MULTIPANE_SCHEMA_VERSION;
	coordinatorId: string;
	/** Creation stamp; doubles as the compare-and-swap guard for writes/removal. */
	epoch: string;
	updatedAt: string;
	/** Serialized shared SplitTree — membership and geometry, no client overlays. */
	layout: string;
	panes: MultipanePaneEntry[];
}

export function serializeMultipaneRecord(record: NativeMultipaneRecord): string {
	return `${JSON.stringify(record, null, 2)}\n`;
}

function parsePanes(value: unknown): MultipanePaneEntry[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const panes: MultipanePaneEntry[] = [];
	const sessionIds = new Set<string>();
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
		const { paneId, sessionId } = entry as Record<string, unknown>;
		if (typeof paneId !== "string" || paneId.length === 0) return null;
		if (typeof sessionId !== "string" || !isValidSessionId(sessionId)) return null;
		if (sessionIds.has(sessionId)) return null;
		sessionIds.add(sessionId);
		panes.push({ paneId, sessionId });
	}
	return panes;
}

/**
 * Parse + strictly validate a record. The layout must restore to a valid
 * SplitTree whose pane set is exactly the bound pane set, in the same order —
 * a record that disagrees with itself is unreadable rather than half-adopted.
 */
export function parseMultipaneRecord(text: string): NativeMultipaneRecord | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	if (r.schemaVersion !== NATIVE_MULTIPANE_SCHEMA_VERSION) return null;
	if (
		typeof r.coordinatorId !== "string" ||
		!isValidCoordinatorId(r.coordinatorId) ||
		typeof r.epoch !== "string" ||
		r.epoch.length === 0 ||
		typeof r.updatedAt !== "string" ||
		typeof r.layout !== "string"
	) {
		return null;
	}
	const tree = restoreSplitTree(r.layout);
	if (!tree) return null;
	const panes = parsePanes(r.panes);
	if (!panes) return null;
	const layoutPaneIds = listPaneIds(tree);
	if (layoutPaneIds.length !== panes.length) return null;
	if (layoutPaneIds.some((paneId, index) => panes[index]?.paneId !== paneId)) return null;
	return {
		schemaVersion: NATIVE_MULTIPANE_SCHEMA_VERSION,
		coordinatorId: r.coordinatorId,
		epoch: r.epoch,
		updatedAt: r.updatedAt,
		layout: r.layout,
		panes,
	};
}

export function readMultipaneRecord(coordinatorId: string): NativeMultipaneRecord | null {
	try {
		return parseMultipaneRecord(readFileSync(coordinatorRecordFile(coordinatorId), "utf8"));
	} catch {
		return null;
	}
}

/** The restored shared layout of a record; null when it is not this schema. */
export function recordLayout(record: NativeMultipaneRecord): SplitTree | null {
	return restoreSplitTree(record.layout);
}

/** Atomically publish a coordinator record (tmp write + rename). */
export function writeMultipaneRecordAtomic(record: NativeMultipaneRecord): void {
	const dir = coordinatorDir(record.coordinatorId);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const target = coordinatorRecordFile(record.coordinatorId);
	const tmp = `${target}.${process.pid}.tmp`;
	writeFileSync(tmp, serializeMultipaneRecord(record), { mode: 0o600 });
	renameSync(tmp, target);
}

/**
 * Remove a coordinator record, but ONLY when its on-disk epoch still matches
 * `expectedEpoch`. Returns false when the guard rejects the removal (the record
 * belongs to a newer coordinator) and true when the state is gone — including
 * when it was already gone, so repeated cleanup is safe.
 */
export function removeMultipaneRecord(coordinatorId: string, expectedEpoch: string): boolean {
	const current = readMultipaneRecord(coordinatorId);
	if (!current) {
		pruneCoordinatorDir(coordinatorId);
		return true;
	}
	if (current.epoch !== expectedEpoch) return false;
	try {
		unlinkSync(coordinatorRecordFile(coordinatorId));
	} catch {
		// concurrent removal — the post-condition (record gone) still holds
	}
	pruneCoordinatorDir(coordinatorId);
	return !existsSync(coordinatorRecordFile(coordinatorId));
}

/** Drop the coordinator directory once it holds nothing (no-op while locked). */
export function pruneCoordinatorDir(coordinatorId: string): void {
	try {
		rmdirSync(coordinatorDir(coordinatorId));
	} catch {
		// dir not empty (unknown siblings) or already gone — leave it
	}
}

/** Every discoverable coordinator id, sorted; unreadable entries are skipped. */
export function listCoordinatorIds(): string[] {
	try {
		return readdirSync(multipaneRootDir(), { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && isValidCoordinatorId(entry.name))
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}
