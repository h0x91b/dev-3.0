import type { LiveArtifact } from "../../shared/types";
import { Utils } from "../electrobun-platform";
import { onLiveStoreChange } from "../live-artifact-store";
import { LiveOpError, runLiveOp } from "../live-artifact-ops";
import { adoptLivePage } from "../live-artifact-handlers";
import { findLiveTask as findTask, liveArtifactUrlFor, liveSendToAgent as sendToAgent } from "../live-artifact-url";
import { getPushMessage, log } from "./shared";

/** Renderer-side routes of the Live Artifact: the viewer's frame transport, Make live, Open in browser. */

// Every store change reaches open viewers (desktop and remote) as one push.
onLiveStoreChange((event) => getPushMessage()?.("liveArtifactChange", event));

async function liveArtifactOp(params: { taskId: string; projectId?: string; op: string; args: Record<string, unknown> }) {
	const { project, task } = await findTask(params.taskId, params.projectId);
	try {
		return { ok: true as const, result: await runLiveOp(project, task, params.op, params.args ?? {}, sendToAgent) };
	} catch (error) {
		const failure = error instanceof LiveOpError ? error : new LiveOpError(String(error), "failed");
		return { ok: false as const, reason: failure.reason, error: failure.message };
	}
}

async function liveArtifactUrl(params: { taskId: string; projectId?: string }): Promise<{ url: string }> {
	const { project, task } = await findTask(params.taskId, params.projectId);
	return { url: liveArtifactUrlFor(project, task) };
}

async function openLiveArtifactInBrowser(params: { taskId: string; projectId?: string }): Promise<void> {
	const { url } = await liveArtifactUrl(params);
	log.info("→ openLiveArtifactInBrowser", { taskId: params.taskId.slice(0, 8) });
	Utils.openExternal(url);
}

async function adoptLiveArtifact(params: { taskId: string; projectId?: string; artifactId: string; version?: number }): Promise<LiveArtifact> {
	const { project, task } = await findTask(params.taskId, params.projectId);
	return (await adoptLivePage(project, task, params.artifactId, params.version, getPushMessage())).liveArtifact;
}

export const liveArtifactHandlers = {
	liveArtifactOp,
	liveArtifactUrl,
	openLiveArtifactInBrowser,
	adoptLiveArtifact,
};
