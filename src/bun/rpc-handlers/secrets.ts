import { getTaskTitle } from "../../shared/types";
import { validateSecretCommand } from "../../shared/secret-request";
import { SecretRequests } from "../secret-requests";
import { runSecretCommand } from "../secret-command";
import { getPushMessage } from "./shared-pure";
import { resolveTaskFromParams } from "../cli-socket/task-resolution";
import type { Handler } from "../cli-socket/shared";

const requests = new SecretRequests(async (request, secret, signal) => {
	const { task } = await resolveTaskFromParams(request as unknown as Record<string, unknown>);
	if (task.worktreePath !== request.cwd || (task.lifecycleStartedAt ?? null) !== request.runStartedAt
		|| task.hibernated || task.status === "completed" || task.status === "cancelled") {
		throw new Error("The task run changed.");
	}
	return await runSecretCommand(request, secret, signal);
}, (name, payload) => getPushMessage()?.(name, payload));

export const secretCliHandlers: Record<string, Handler> = {
	"secret.run": async (params, ctx) => {
		validateSecretCommand(params.env, params.command);
		if (!getPushMessage()) throw new Error("Connect an app window to answer the secret request.");
		const { project, task } = await resolveTaskFromParams(params);
		if (!task.worktreePath || task.hibernated || task.status === "completed" || task.status === "cancelled") {
			throw new Error("Secret commands need an active task worktree.");
		}
		return await requests.request({
			projectId: project.id, taskId: task.id, taskTitle: getTaskTitle(task),
			env: params.env as string, command: params.command, cwd: task.worktreePath, runStartedAt: task.lifecycleStartedAt ?? null,
		}, ctx?.signal);
	},
};

export const secretHandlers = {
	listSecretRequests: async () => requests.list(),
	respondToSecretRequest: async (params: { requestId: string; secret?: string }) => {
		try { return requests.respond(params.requestId, params.secret); }
		finally { delete params.secret; }
	},
};
