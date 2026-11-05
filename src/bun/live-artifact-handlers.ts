import type { LiveArtifact, Project, SharedArtifact, Task } from "../shared/types";
import { TERMINAL_STATUSES } from "../shared/types";
import { artifactAtVersion, latestArtifactVersion } from "../shared/artifact-versions";
import {
	liveAckEvents,
	liveDeleteDoc,
	livePatchDoc,
	liveSetDoc,
	LIVE_READ_ONLY_PREFIX,
	LiveStoreError,
	type LiveChange,
} from "../shared/live-artifact";
import { saveSharedArtifact, SharedArtifactError } from "./shared-artifacts";
import { emitLivePageChange, liveStoreBytes, mutateLiveState, readLiveState, wipeLiveStore } from "./live-artifact-store";
import * as data from "./data";

/** `dev3 live …` socket routes. The agent is always the writer here; the page writes through its own channel. */

type Handler = (params: Record<string, unknown>) => Promise<unknown>;

export interface LiveHandlerDeps {
	resolveTask: (params: Record<string, unknown>) => Promise<{ project: Project; task: Task }>;
	push: () => ((event: string, payload: unknown) => void) | null | undefined;
}

function str(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || !value) throw new LiveStoreError(`${key} is required`);
	return value;
}

function optionalRev(params: Record<string, unknown>): number | undefined {
	if (params.ifRev === undefined || params.ifRev === null) return undefined;
	const rev = Number(params.ifRev);
	if (!Number.isInteger(rev) || rev < 0) throw new LiveStoreError(`Invalid --if-rev "${String(params.ifRev)}"`);
	return rev;
}

function assertWritable(task: Task): void {
	if (TERMINAL_STATUSES.includes(task.status)) {
		throw new LiveStoreError(`${LIVE_READ_ONLY_PREFIX}task is ${task.status}; its live artifact is read-only`);
	}
}

function findArtifact(task: Task, ref: string): SharedArtifact {
	const matches = (task.sharedArtifacts ?? []).filter((artifact) => artifact.id === ref || artifact.id.startsWith(ref));
	if (matches.length === 0) throw new LiveStoreError(`No artifact ${ref} on this task (see the artifact list in the app)`);
	if (matches.length > 1) throw new LiveStoreError(`Ambiguous artifact id ${ref}: ${matches.map((a) => a.id.slice(0, 8)).join(", ")}`);
	return matches[0];
}

/** Point the task's live slot at `page` and tell every open copy to reload. */
export async function setLivePage(
	project: Project,
	task: Task,
	page: SharedArtifact,
	push: ((event: string, payload: unknown) => void) | null | undefined,
): Promise<LiveArtifact> {
	const { task: updated, result } = await data.updateTaskWith<LiveArtifact>(project, task.id, (current) => {
		const now = Date.now();
		const live: LiveArtifact = {
			page: { ...page, isUnread: false },
			pageRev: (current.liveArtifact?.pageRev ?? 0) + 1,
			createdAt: current.liveArtifact?.createdAt ?? now,
			updatedAt: now,
		};
		return { updates: { liveArtifact: live }, result: live };
	});
	push?.("taskUpdated", { projectId: project.id, task: updated });
	emitLivePageChange(task.id, result.pageRev);
	return result;
}

/** `live.adopt` and the viewer's Make live: an existing artifact version becomes the live page. */
export async function adoptLivePage(
	project: Project,
	task: Task,
	artifactRef: string,
	versionArg: unknown,
	push: ((event: string, payload: unknown) => void) | null | undefined,
): Promise<{ adoptedFrom: { id: string; version: number }; liveArtifact: LiveArtifact }> {
	assertWritable(task);
	const artifact = findArtifact(task, artifactRef);
	const version = versionArg === undefined || versionArg === null ? latestArtifactVersion(artifact) : Number(versionArg);
	if (!Number.isInteger(version) || version < 1) throw new LiveStoreError(`Invalid --version "${String(versionArg)}"`);
	// Stored artifact dirs are never rewritten, so the live slot can point at the
	// chosen version's record directly — the original artifact is unaffected.
	const { previousVersions: _versions, ...page } = artifactAtVersion(artifact, version);
	return { adoptedFrom: { id: artifact.id, version }, liveArtifact: await setLivePage(project, task, page, push) };
}

export function createLiveHandlers(deps: LiveHandlerDeps): Record<string, Handler> {
	function writeDoc(
		params: Record<string, unknown>,
		apply: (draft: Parameters<typeof liveSetDoc>[0], write: { collection: string; id: string; by: "agent"; now: number; ifRev?: number }) => LiveChange | null,
	) {
		return (async () => {
			const { project, task } = await deps.resolveTask(params);
			assertWritable(task);
			const write = { collection: str(params, "collection"), id: str(params, "id"), by: "agent" as const, now: Date.now(), ifRev: optionalRev(params) };
			return mutateLiveState(project.path, task.id, (draft) => {
				const change = apply(draft, write);
				return { result: change, changes: change ? [change] : [] };
			});
		})();
	}

	return {
		"live.publish": async (params) => {
			const { project, task } = await deps.resolveTask(params);
			assertWritable(task);
			const assetPaths = Array.isArray(params.assetPaths)
				? params.assetPaths.filter((path): path is string => typeof path === "string" && path.length > 0)
				: [];
			const title = typeof params.title === "string" && params.title.trim() ? params.title.trim() : task.liveArtifact?.page.title;
			let page: SharedArtifact;
			try {
				page = saveSharedArtifact(project.path, str(params, "htmlPath"), assetPaths, title, { forceNew: true });
			} catch (error) {
				if (error instanceof SharedArtifactError) throw new LiveStoreError(error.message);
				throw error;
			}
			return { taskId: task.id, liveArtifact: await setLivePage(project, task, page, deps.push()) };
		},

		"live.adopt": async (params) => {
			const { project, task } = await deps.resolveTask(params);
			return { taskId: task.id, ...(await adoptLivePage(project, task, str(params, "artifact"), params.version, deps.push())) };
		},

		"live.status": async (params) => {
			const { project, task } = await deps.resolveTask(params);
			const state = await readLiveState(project.path, task.id);
			const collections = Object.fromEntries(Object.entries(state.collections).map(([name, docs]) => [name, Object.keys(docs).length]));
			return {
				taskId: task.id,
				readOnly: TERMINAL_STATUSES.includes(task.status),
				liveArtifact: task.liveArtifact ?? null,
				rev: state.rev,
				collections,
				events: { total: state.events.length, unhandled: state.events.filter((event) => !event.handled).length },
				bytes: liveStoreBytes(project.path, task.id),
			};
		},

		"live.get": async (params) => {
			const { project, task } = await deps.resolveTask(params);
			const state = await readLiveState(project.path, task.id);
			const collection = str(params, "collection");
			const id = str(params, "id");
			const doc = state.collections[collection]?.[id];
			if (!doc) throw new LiveStoreError(`No document ${collection}/${id}`);
			return doc;
		},

		"live.list": async (params) => {
			const { project, task } = await deps.resolveTask(params);
			const state = await readLiveState(project.path, task.id);
			const collection = typeof params.collection === "string" && params.collection ? params.collection : null;
			if (!collection) return { collections: Object.fromEntries(Object.entries(state.collections).map(([name, docs]) => [name, Object.keys(docs).length])) };
			return { collection, docs: Object.values(state.collections[collection] ?? {}) };
		},

		"live.set": (params) => writeDoc(params, (draft, write) => liveSetDoc(draft, { ...write, data: params.data })),
		"live.patch": (params) => writeDoc(params, (draft, write) => livePatchDoc(draft, { ...write, patch: params.patch })),
		"live.delete": async (params) => ({ deleted: (await writeDoc(params, (draft, write) => liveDeleteDoc(draft, write))) !== null }),

		"live.events": async (params) => {
			const { project, task } = await deps.resolveTask(params);
			const state = await readLiveState(project.path, task.id);
			const since = params.since === undefined ? 0 : Number(params.since);
			return state.events.filter((event) => event.id > since && (params.unhandled !== true || !event.handled));
		},

		"live.ack": async (params) => {
			const { project, task } = await deps.resolveTask(params);
			const ids = params.all === true ? ("all" as const) : Array.isArray(params.ids) ? params.ids.map(Number).filter(Number.isInteger) : [];
			if (ids !== "all" && ids.length === 0) throw new LiveStoreError("Pass event ids or --all");
			return mutateLiveState(project.path, task.id, (draft) => {
				const acked = liveAckEvents(draft, ids);
				return { result: { acked }, changes: [], dirty: acked > 0 };
			});
		},

		// Removes the live page pointer; the store survives unless `data` is set.
		"live.clear": async (params) => {
			const { project, task } = await deps.resolveTask(params);
			assertWritable(task);
			const { task: updated } = await data.updateTaskWith<null>(project, task.id, () => ({ updates: { liveArtifact: undefined }, result: null }));
			if (params.data === true) await wipeLiveStore(project.path, task.id);
			deps.push()?.("taskUpdated", { projectId: project.id, task: updated });
			return { taskId: task.id, clearedData: params.data === true };
		},
	};
}
