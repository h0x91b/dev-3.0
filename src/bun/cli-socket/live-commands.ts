import { createLiveHandlers } from "../live-artifact-handlers";
import { liveArtifactUrlFor } from "../live-artifact-url";
import { getPushMessage } from "../rpc-handlers";
import type { Handler } from "./shared";
import { resolveTaskFromParams } from "./task-resolution";

/** `dev3 live …` — the task's one Live Artifact. */
export const liveHandlers: Record<string, Handler> = {
	...createLiveHandlers({ resolveTask: resolveTaskFromParams, push: getPushMessage }),
	"live.url": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		return { taskId: task.id, url: liveArtifactUrlFor(project, task), hasPage: Boolean(task.liveArtifact) };
	},
};
