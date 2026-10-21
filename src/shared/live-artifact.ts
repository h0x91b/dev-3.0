/**
 * Pure rules of a Live Artifact's state store: names, limits, merge, and the
 * mutations themselves. The app process owns the file (`src/bun/live-artifact-store.ts`);
 * everything here is I/O-free so it is tested directly.
 * See `decisions/2026/10/21/live-artifact-per-task.md`.
 */

import type { LiveArtifact, SharedArtifact } from "./types/shared-media";

export const LIVE_LIMITS = {
	collections: 64,
	docsPerCollection: 2000,
	docBytes: 256 * 1024,
	storeBytes: 8 * 1024 * 1024,
	events: 5000,
} as const;

/** Error-message prefixes the CLI maps to their own exit codes. */
export const LIVE_REV_CONFLICT_PREFIX = "LIVE_REV_CONFLICT: ";
export const LIVE_READ_ONLY_PREFIX = "LIVE_READ_ONLY: ";

export type LiveWriter = "agent" | "user";

export interface LiveDoc {
	id: string;
	data: unknown;
	/** Store-wide revision at the moment this document last changed. */
	rev: number;
	updatedAt: number;
	updatedBy: LiveWriter;
}

export type LiveEventKind = "set" | "patch" | "delete" | "emit";

/** Something the user did on the live page, waiting for the agent. */
export interface LiveEvent {
	id: number;
	ts: number;
	kind: LiveEventKind;
	collection?: string;
	docId?: string;
	/** For `emit`: the event name the page chose. */
	name?: string;
	payload?: unknown;
	handled: boolean;
}

export interface LiveState {
	schema: 1;
	rev: number;
	collections: Record<string, Record<string, LiveDoc>>;
	events: LiveEvent[];
	nextEventId: number;
}

export interface LiveChange {
	rev: number;
	kind: Exclude<LiveEventKind, "emit">;
	collection: string;
	docId: string;
	doc: LiveDoc | null;
	by: LiveWriter;
}

export class LiveStoreError extends Error {}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export function emptyLiveState(): LiveState {
	return { schema: 1, rev: 0, collections: {}, events: [], nextEventId: 1 };
}

export function assertLiveName(kind: "collection" | "document id" | "event name", name: unknown): string {
	if (typeof name !== "string" || !NAME_RE.test(name)) {
		throw new LiveStoreError(
			`Invalid ${kind} ${JSON.stringify(name)}: use 1-64 letters, digits, '.', '_', ':' or '-', starting with a letter or digit`,
		);
	}
	return name;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON Merge Patch (RFC 7396): objects merge recursively, `null` removes a key, anything else replaces. */
export function mergePatch(base: unknown, patch: unknown): unknown {
	if (!isPlainObject(patch)) return patch;
	const result: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete result[key];
		else result[key] = mergePatch(result[key], value);
	}
	return result;
}

function assertDocSize(data: unknown): void {
	const bytes = new TextEncoder().encode(JSON.stringify(data) ?? "").byteLength;
	if (bytes > LIVE_LIMITS.docBytes) {
		throw new LiveStoreError(`Document is ${bytes} bytes (max ${LIVE_LIMITS.docBytes}); split it across documents`);
	}
}

function assertRev(existing: LiveDoc | undefined, ifRev: number | undefined): void {
	if (ifRev === undefined) return;
	const current = existing?.rev ?? 0;
	if (current !== ifRev) {
		throw new LiveStoreError(`${LIVE_REV_CONFLICT_PREFIX}document is at rev ${current}, not ${ifRev}; re-read it and retry`);
	}
}

/** Drop the oldest handled events first, then the oldest of the rest, down to the cap. */
export function trimLiveEvents(events: LiveEvent[], cap: number = LIVE_LIMITS.events): LiveEvent[] {
	if (events.length <= cap) return events;
	let excess = events.length - cap;
	const kept = events.filter((event) => {
		if (excess > 0 && event.handled) {
			excess--;
			return false;
		}
		return true;
	});
	return excess > 0 ? kept.slice(excess) : kept;
}

function recordUserEvent(state: LiveState, event: Omit<LiveEvent, "id" | "handled">): void {
	state.events = trimLiveEvents([...state.events, { ...event, id: state.nextEventId++, handled: false }]);
}

export interface LiveWrite {
	collection: string;
	id: string;
	by: LiveWriter;
	now: number;
	ifRev?: number;
}

function applyDocWrite(state: LiveState, write: LiveWrite, kind: "set" | "patch", next: (prev: unknown) => unknown): LiveChange {
	const collection = assertLiveName("collection", write.collection);
	const id = assertLiveName("document id", write.id);
	const docs = state.collections[collection];
	const existing = docs?.[id];
	assertRev(existing, write.ifRev);
	if (!docs && Object.keys(state.collections).length >= LIVE_LIMITS.collections) {
		throw new LiveStoreError(`Too many collections (max ${LIVE_LIMITS.collections})`);
	}
	if (!existing && docs && Object.keys(docs).length >= LIVE_LIMITS.docsPerCollection) {
		throw new LiveStoreError(`Collection "${collection}" is full (max ${LIVE_LIMITS.docsPerCollection} documents)`);
	}
	const data = next(existing?.data);
	if (data === undefined) throw new LiveStoreError("Document data is required");
	assertDocSize(data);
	const rev = state.rev + 1;
	const doc: LiveDoc = { id, data, rev, updatedAt: write.now, updatedBy: write.by };
	state.rev = rev;
	state.collections[collection] = { ...docs, [id]: doc };
	if (write.by === "user") recordUserEvent(state, { ts: write.now, kind, collection, docId: id, payload: data });
	return { rev, kind, collection, docId: id, doc, by: write.by };
}

export function liveSetDoc(state: LiveState, write: LiveWrite & { data: unknown }): LiveChange {
	return applyDocWrite(state, write, "set", () => write.data);
}

export function livePatchDoc(state: LiveState, write: LiveWrite & { patch: unknown }): LiveChange {
	return applyDocWrite(state, write, "patch", (prev) => mergePatch(prev, write.patch));
}

/** Returns null when the document did not exist (nothing changed). */
export function liveDeleteDoc(state: LiveState, write: LiveWrite): LiveChange | null {
	const collection = assertLiveName("collection", write.collection);
	const id = assertLiveName("document id", write.id);
	const existing = state.collections[collection]?.[id];
	assertRev(existing, write.ifRev);
	if (!existing) return null;
	const { [id]: _removed, ...rest } = state.collections[collection];
	if (Object.keys(rest).length === 0) delete state.collections[collection];
	else state.collections[collection] = rest;
	state.rev += 1;
	if (write.by === "user") recordUserEvent(state, { ts: write.now, kind: "delete", collection, docId: id });
	return { rev: state.rev, kind: "delete", collection, docId: id, doc: null, by: write.by };
}

/** A named event from the page with no document attached ("send these answers"). */
export function liveEmit(state: LiveState, input: { name: string; payload?: unknown; now: number }): LiveEvent {
	const name = assertLiveName("event name", input.name);
	if (input.payload !== undefined) assertDocSize(input.payload);
	recordUserEvent(state, { ts: input.now, kind: "emit", name, payload: input.payload });
	return state.events[state.events.length - 1];
}

/** Marks events handled; returns how many changed state. */
export function liveAckEvents(state: LiveState, ids: number[] | "all"): number {
	let count = 0;
	state.events = state.events.map((event) => {
		if (event.handled || (ids !== "all" && !ids.includes(event.id))) return event;
		count++;
		return { ...event, handled: true };
	});
	return count;
}

/** Reject anything that is not a store this code wrote, instead of overwriting it. */
export function parseLiveState(text: string): LiveState {
	const parsed = JSON.parse(text) as Partial<LiveState>;
	if (parsed?.schema !== 1 || typeof parsed.rev !== "number" || !isPlainObject(parsed.collections) || !Array.isArray(parsed.events)) {
		throw new LiveStoreError("Live store file is not a schema-1 store; refusing to overwrite it");
	}
	return { ...emptyLiveState(), ...parsed } as LiveState;
}

const LIVE_ENTRY_PREFIX = "live:";

/**
 * The live page as one more entry in the artifact viewer's list. Always version 1,
 * so the viewer's unsent-input draft (keyed by id + version) survives a new page
 * and is put back after the reload.
 */
export function liveViewerEntry(taskId: string, live: LiveArtifact): SharedArtifact {
	return { ...live.page, id: `${LIVE_ENTRY_PREFIX}${taskId}`, groupKey: "live", version: 1, previousVersions: undefined, isUnread: false };
}

export function isLiveViewerEntry(artifact: Pick<SharedArtifact, "id"> | undefined): boolean {
	return Boolean(artifact?.id.startsWith(LIVE_ENTRY_PREFIX));
}
