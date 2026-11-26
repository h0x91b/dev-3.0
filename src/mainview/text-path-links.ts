import { useEffect, useState } from "react";
import { api } from "./rpc";
import type { ResolvedTerminalPath } from "../shared/types";
import { isRootedPathText, pathBaseName } from "../shared/path-candidates";

/**
 * Resolves paths written in task text through the terminal's `resolveTerminalPaths`
 * RPC (same roots gate, same bases): one batched call per scope per tick, cached briefly.
 */

const TTL_MS = 15_000;
/** Entries kept at most: a long-lived tab renders many distinct paths. */
const CACHE_MAX = 2_000;
/** Mirrors the backend's per-call cap (`RESOLVE_TERMINAL_PATHS_MAX`). */
const BATCH_MAX = 64;

type Resolution = ResolvedTerminalPath | null;

const cache = new Map<string, { at: number; promise: Promise<Resolution> }>();

interface ScopeBatch {
	projectId?: string;
	taskId?: string;
	waiters: Map<string, Array<(value: Resolution) => void>>;
}

const pending = new Map<string, ScopeBatch>();
let flushScheduled = false;

function scopeKey(projectId?: string, taskId?: string): string {
	return `${projectId ?? ""}\0${taskId ?? ""}`;
}

async function flushScope(batch: ScopeBatch): Promise<void> {
	const paths = [...batch.waiters.keys()];
	for (let i = 0; i < paths.length; i += BATCH_MAX) {
		const chunk = paths.slice(i, i + BATCH_MAX);
		let resolved: Record<string, Resolution> = {};
		try {
			resolved = (await api.request.resolveTerminalPaths({ projectId: batch.projectId, taskId: batch.taskId, paths: chunk })).resolved;
		} catch {
			// unreachable backend → every path stays plain text
		}
		for (const path of chunk) {
			for (const resolve of batch.waiters.get(path) ?? []) resolve(resolved[path] ?? null);
		}
	}
}

function flush(): void {
	flushScheduled = false;
	const batches = [...pending.values()];
	pending.clear();
	for (const batch of batches) void flushScope(batch);
}

/** What `path` names on disk for text owned by `projectId` / `taskId`, or null. */
export function resolveTextPath(path: string, projectId?: string, taskId?: string): Promise<Resolution> {
	const scope = scopeKey(projectId, taskId);
	const key = `${scope}\0${path}`;
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
	const promise = new Promise<Resolution>((resolve) => {
		let batch = pending.get(scope);
		if (!batch) {
			batch = { projectId, taskId, waiters: new Map() };
			pending.set(scope, batch);
		}
		const waiters = batch.waiters.get(path) ?? [];
		waiters.push(resolve);
		batch.waiters.set(path, waiters);
		if (!flushScheduled) {
			flushScheduled = true;
			queueMicrotask(flush);
		}
	});
	if (cache.size >= CACHE_MAX) {
		const now = Date.now();
		for (const [stale, entry] of cache) if (now - entry.at >= TTL_MS) cache.delete(stale);
		if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
	}
	cache.set(key, { at: Date.now(), promise });
	return promise;
}

export function clearTextPathCache(): void {
	cache.clear();
}

/** `undefined` while resolving, `null` when the path names nothing reachable. */
export function useResolvedTextPath(path: string, projectId?: string, taskId?: string): Resolution | undefined {
	const [state, setState] = useState<{ key: string; value: Resolution } | null>(null);
	const key = `${scopeKey(projectId, taskId)}\0${path}`;
	useEffect(() => {
		let alive = true;
		void resolveTextPath(path, projectId, taskId).then((value) => {
			if (alive) setState({ key, value });
		});
		return () => { alive = false; };
	}, [key, path, projectId, taskId]);
	return state?.key === key ? state.value : undefined;
}

/**
 * The chip label for a written path: an absolute or home path (any platform)
 * shows its file name, since the leading directories are noise in prose. A
 * relative path is already short and says where it lives, so it shows as written.
 */
export function pathLinkLabel(raw: string): string {
	if (!isRootedPathText(raw)) return raw;
	return pathBaseName(raw) || raw;
}
