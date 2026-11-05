import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./rpc";
import type { TaskPrRefPreview } from "../shared/task-refs";

// Hover previews re-fire on every pass over a link; a short-lived cache keeps
// a paragraph full of the same `<seq:N>` from becoming one RPC per mouse move.
const TTL_MS = 15_000;
const cache = new Map<string, { at: number; promise: Promise<TaskPrRefPreview | null> }>();

export function loadTaskPrRefPreview(ref: string, contextProjectId?: string, fresh = false): Promise<TaskPrRefPreview | null> {
	const key = `${contextProjectId ?? ""}\0${ref}`;
	const hit = cache.get(key);
	if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.promise;
	const promise = api.request.previewTaskPrRef({ ref, contextProjectId, ...(fresh ? { fresh } : {}) }).catch(() => null);
	cache.set(key, { at: Date.now(), promise });
	return promise;
}

export function clearTaskPrRefPreviewCache(): void {
	cache.clear();
}

export type PreviewState = { status: "idle" | "loading" } | { status: "ready"; preview: TaskPrRefPreview | null };

/** Lazy preview for one reference: nothing is fetched until `load()`. */
export function useTaskPrRefPreview(ref: string, contextProjectId?: string) {
	const [state, setState] = useState<PreviewState>({ status: "idle" });
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => { alive.current = false; };
	}, []);
	useEffect(() => setState({ status: "idle" }), [ref, contextProjectId]);

	const run = useCallback(async (fresh: boolean) => {
		setState((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
		const preview = await loadTaskPrRefPreview(ref, contextProjectId, fresh);
		if (alive.current) setState({ status: "ready", preview });
	}, [contextProjectId, ref]);

	const load = useCallback(() => { void run(false); }, [run]);
	const refresh = useCallback(() => run(true), [run]);
	return { state, load, refresh };
}
