import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { atomicWriteFile } from "./atomic-write";
import { projectSlug } from "./git";
import { DEV3_HOME } from "./paths";
import {
	emptyLiveState,
	LIVE_LIMITS,
	LiveStoreError,
	parseLiveState,
	type LiveChange,
	type LiveState,
} from "../shared/live-artifact";

/**
 * File I/O for a task's Live Artifact store. One JSON file per task, written only
 * by the app process (the CLI goes through the socket), mutations serialized per
 * file. Rules and mutations themselves live in `src/shared/live-artifact.ts`.
 */

const TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cache = new Map<string, LiveState>();
const queues = new Map<string, Promise<unknown>>();
const listeners = new Set<(event: { taskId: string; changes: LiveChange[] }) => void>();
const pageListeners = new Set<(event: { taskId: string; pageRev: number }) => void>();

export function liveStoreDir(projectPath: string, taskId: string): string {
	if (!TASK_ID_RE.test(taskId)) throw new LiveStoreError(`Invalid task id: ${taskId}`);
	return `${DEV3_HOME}/worktrees/${projectSlug(projectPath)}/live-artifacts/${taskId}`;
}

function storeFile(projectPath: string, taskId: string): string {
	return `${liveStoreDir(projectPath, taskId)}/state.json`;
}

function load(file: string): LiveState {
	const cached = cache.get(file);
	if (cached) return cached;
	const state = existsSync(file) ? parseLiveState(readFileSync(file, "utf8")) : emptyLiveState();
	cache.set(file, state);
	return state;
}

function serialized<T>(file: string, run: () => Promise<T>): Promise<T> {
	const previous = queues.get(file) ?? Promise.resolve();
	const next = previous.catch(() => {}).then(run);
	queues.set(file, next);
	return next;
}

/** Live change subscribers (the live server's push stream, the viewer). */
export function onLiveStoreChange(listener: (event: { taskId: string; changes: LiveChange[] }) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** A new live page was published or adopted: open copies must reload. */
export function onLivePageChange(listener: (event: { taskId: string; pageRev: number }) => void): () => void {
	pageListeners.add(listener);
	return () => pageListeners.delete(listener);
}

export function emitLivePageChange(taskId: string, pageRev: number): void {
	for (const listener of pageListeners) listener({ taskId, pageRev });
}

export function readLiveState(projectPath: string, taskId: string): Promise<LiveState> {
	const file = storeFile(projectPath, taskId);
	return serialized(file, async () => load(file));
}

/**
 * Run `mutate` on a copy of the store and persist it. A throw leaves both the
 * file and the cache untouched. `mutate` returns its result plus the document
 * changes to broadcast.
 */
export function mutateLiveState<T>(
	projectPath: string,
	taskId: string,
	mutate: (draft: LiveState) => { result: T; changes: LiveChange[]; dirty?: boolean },
): Promise<T> {
	const file = storeFile(projectPath, taskId);
	return serialized(file, async () => {
		const draft = structuredClone(load(file));
		const { result, changes, dirty } = mutate(draft);
		if (changes.length === 0 && !dirty) return result;
		const text = JSON.stringify(draft);
		if (Buffer.byteLength(text) > LIVE_LIMITS.storeBytes) {
			throw new LiveStoreError(`Live store would grow past ${LIVE_LIMITS.storeBytes / 1024 / 1024} MB; delete documents first`);
		}
		mkdirSync(liveStoreDir(projectPath, taskId), { recursive: true });
		await atomicWriteFile(file, text);
		cache.set(file, draft);
		if (changes.length > 0) for (const listener of listeners) listener({ taskId, changes });
		return result;
	});
}

export function liveStoreBytes(projectPath: string, taskId: string): number {
	const file = storeFile(projectPath, taskId);
	return existsSync(file) ? statSync(file).size : 0;
}

/** Remove the task's store: only on an explicit `dev3 live clear --data`. */
export function wipeLiveStore(projectPath: string, taskId: string): Promise<void> {
	const file = storeFile(projectPath, taskId);
	return serialized(file, async () => {
		rmSync(file, { force: true });
		cache.delete(file);
	});
}
