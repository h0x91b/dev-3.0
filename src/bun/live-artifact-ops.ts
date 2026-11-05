import type { Project, Task } from "../shared/types";
import { TERMINAL_STATUSES } from "../shared/types";
import { wrapArtifactMessage } from "../shared/agent-message-envelope";
import {
	liveDeleteDoc,
	liveEmit,
	livePatchDoc,
	liveSetDoc,
	LIVE_READ_ONLY_PREFIX,
	LIVE_REV_CONFLICT_PREFIX,
	LiveStoreError,
	type LiveChange,
} from "../shared/live-artifact";
import { mutateLiveState, readLiveState } from "./live-artifact-store";

/**
 * What the live PAGE may do — always as the user. Shared by the viewer's RPC
 * (in-app frame) and the loopback HTTP server (browser tab), so the two
 * transports cannot drift apart.
 */

export type LiveOpFailureReason = "invalid" | "conflict" | "read-only" | "failed";

export class LiveOpError extends Error {
	constructor(message: string, readonly reason: LiveOpFailureReason) {
		super(message);
	}
}

/** Delivery into the agent pane, injected so this module stays free of the scheduler. */
export type LiveAgentSender = (task: Task, text: string) => Promise<unknown>;

function optionalRev(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	const rev = Number(value);
	if (!Number.isInteger(rev) || rev < 0) throw new LiveOpError(`Invalid ifRev ${JSON.stringify(value)}`, "invalid");
	return rev;
}

function asOpError(error: unknown): LiveOpError {
	if (error instanceof LiveOpError) return error;
	const message = error instanceof Error ? error.message : String(error);
	if (message.startsWith(LIVE_REV_CONFLICT_PREFIX)) return new LiveOpError(message.slice(LIVE_REV_CONFLICT_PREFIX.length), "conflict");
	if (message.startsWith(LIVE_READ_ONLY_PREFIX)) return new LiveOpError(message.slice(LIVE_READ_ONLY_PREFIX.length), "read-only");
	return new LiveOpError(message, error instanceof LiveStoreError ? "invalid" : "failed");
}

export async function runLiveOp(
	project: Project,
	task: Task,
	op: string,
	args: Record<string, unknown>,
	sendToAgent: LiveAgentSender,
): Promise<unknown> {
	try {
		if (op === "state") return await readLiveState(project.path, task.id);
		if (TERMINAL_STATUSES.includes(task.status)) {
			throw new LiveOpError(`task is ${task.status}; its live artifact is read-only`, "read-only");
		}
		const now = Date.now();
		if (op === "emit") {
			return await mutateLiveState(project.path, task.id, (draft) => ({
				result: liveEmit(draft, { name: String(args.name ?? ""), payload: args.payload, now }),
				changes: [],
				dirty: true,
			}));
		}
		if (op === "send") {
			const text = typeof args.text === "string" ? args.text.trim() : "";
			if (!text) throw new LiveOpError("Nothing to send", "invalid");
			const title = task.liveArtifact?.page.title ?? "Live page";
			const rev = task.liveArtifact?.pageRev ?? 1;
			await sendToAgent(task, wrapArtifactMessage(text, { title: `${title} (live)`, version: rev, versionCount: rev }));
			return { sent: true };
		}
		if (op !== "set" && op !== "patch" && op !== "delete") throw new LiveOpError(`Unknown live operation "${op}"`, "invalid");
		const write = {
			collection: String(args.collection ?? ""),
			id: String(args.id ?? ""),
			by: "user" as const,
			now,
			ifRev: optionalRev(args.ifRev),
		};
		return await mutateLiveState(project.path, task.id, (draft) => {
			let change: LiveChange | null;
			if (op === "set") change = liveSetDoc(draft, { ...write, data: args.data });
			else if (op === "patch") change = livePatchDoc(draft, { ...write, patch: args.patch });
			else change = liveDeleteDoc(draft, write);
			return { result: change, changes: change ? [change] : [] };
		});
	} catch (error) {
		throw asOpError(error);
	}
}
