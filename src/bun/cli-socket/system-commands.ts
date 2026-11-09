import { DEV3_REPO_CONFIG_KEYS, repoConfigEnabled } from "../../shared/types";
import * as data from "../data";
import { loadSpacesFile } from "../spaces-data";
import { getPushMessage, getPushMessageLocal } from "../rpc-handlers";
import { getDevServerStatus, runDevServer, stopDevServer, restartDevServer } from "../rpc-handlers/tmux-pty";
import { NATIVE_PROMPT_DELIVERY_METHOD, deliverNativePromptAsOwner } from "../agent-prompt-native";
import { NATIVE_PANE_INPUT_METHOD, runNativePaneInputAsOwner } from "../pane-input-native";
import type { PaneInputProgram } from "../../shared/pane-input";
import * as repoConfig from "../repo-config";
import { COMMAND_BEARING_CONFIG_KEYS, resolveConfigPath } from "../../shared/config-schema";
import type { Project } from "../../shared/types";
import { LAUNCH_ACTIVATE_METHOD, handleLaunchActivate } from "../launch-handoff";
import { log, type Handler } from "./shared";
import { readEnvParam, readServerParams, resolveTaskFromParams } from "./task-resolution";

export const systemHandlers: Record<string, Handler> = {
	// A second Linux desktop launch asking this instance to show a window instead.
	[LAUNCH_ACTIVATE_METHOD]: async (params) => handleLaunchActivate(params),

	// Cross-instance notification: another dev-3.0 instance changed data.
	// Re-read from disk and push to local renderer only (no re-broadcast).
	"_notify": async (params) => {
		const event = params.event as string;
		const projectId = params.projectId as string;
		const taskId = params.taskId as string | undefined;
		const localPush = getPushMessageLocal();
		if (!localPush) return {};

		try {
			if (event === "taskUpdated" && projectId && taskId) {
				const project = await data.getProject(projectId);
				const tasks = await data.loadTasks(project);
				const task = tasks.find((t) => t.id === taskId);
				if (task) localPush("taskUpdated", { projectId, task });
			} else if (event === "taskRemoved" && projectId && taskId) {
				// Another instance moved/deleted a task out of this project — drop it
				// from the local board. No disk read: the task is already gone there.
				localPush("taskRemoved", { projectId, taskId });
			} else if (event === "projectUpdated" && projectId) {
				const project = await data.getProject(projectId);
				localPush("projectUpdated", { project });
			} else if (event === "projectAdded" && projectId) {
				const project = await data.getProject(projectId);
				localPush("projectAdded", { project });
			} else if (event === "agentMessageLogChanged" && projectId) {
				localPush("agentMessageLogChanged", { projectId });
			} else if (event === "spacesUpdated") {
				// Re-read locally: the identity-checked cache sees the peer's write.
				const file = await loadSpacesFile();
				localPush("spacesUpdated", { file });
			}
		} catch (err) {
			log.debug("_notify handler error (non-fatal)", { event, error: String(err) });
		}
		return {};
	},

	// Owner-routed half of native prompt delivery: another dev-3.0 instance
	// resolved US as the holder of this pane's writer lease and handed over the
	// whole delivery. Performs it here, exactly once, and never forwards again
	// (see agent-prompt-native.ts) — a stale owner answer cannot start a hop loop.
	[NATIVE_PROMPT_DELIVERY_METHOD]: async (params) => {
		const delivered = await deliverNativePromptAsOwner({
			taskId: (params.taskId as string) ?? "",
			paneId: (params.paneId as string) ?? "",
			text: ((params.text as string) ?? "").toString(),
			hold: params.hold === true,
		});
		return { delivered };
	},

	// Owner-routed half of native pane input: same hop and dead-end rule as the prompt
	// delivery above, plus two of its own — the owner deduplicates by delivery id and
	// never claims a lease. The whole typed outcome is the reply.
	[NATIVE_PANE_INPUT_METHOD]: async (params) =>
		runNativePaneInputAsOwner(params as unknown as PaneInputProgram),

	"devServer.start": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		return runDevServer({
			taskId: task.id,
			projectId: project.id,
			env: readEnvParam(params),
			// Validated by the handler: it is also reachable from the renderer.
			args: params.args as string[] | undefined,
			...readServerParams(params),
		});
	},

	"devServer.stop": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		return stopDevServer({ taskId: task.id, projectId: project.id, ...readServerParams(params) });
	},

	"devServer.restart": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		return restartDevServer({
			taskId: task.id,
			projectId: project.id,
			env: readEnvParam(params),
			// Validated by the handler: it is also reachable from the renderer.
			args: params.args as string[] | undefined,
			...readServerParams(params),
		});
	},

	"devServer.status": async (params) => {
		const { project, task } = await resolveTaskFromParams(params);
		return getDevServerStatus({ taskId: task.id, projectId: project.id });
	},

	"config.export": async (params) => {
		const projectId = params.projectId as string;
		if (!projectId) throw new Error("projectId is required");
		const worktreePath = params.worktreePath as string | undefined;
		const project = await data.getProject(projectId);
		const configPath = worktreePath || project.path;
		// migrateProjectConfig is a no-op while repo config is off, so exporting
		// would report a path it never wrote. Say why instead.
		if (!repoConfigEnabled(project)) {
			throw new Error("Repository dev3 configuration is disabled for this project — enable \"Use repository dev3 configuration\" in Project Settings first.");
		}
		await repoConfig.migrateProjectConfig(project, configPath);
		return { path: `${configPath}/.dev3/config.json` };
	},

	"config.show": async (params) => {
		const { project, worktreePath, foreignCode } = await configTarget(params);
		// The same cascade a task launch uses: worktree files, then the main
		// checkout's, then projects.json, then defaults.
		const resolved = await repoConfig.resolveOperationalProjectConfig(project, worktreePath, { foreignCode });
		const layers = repoConfig.listConfigLayers(project, worktreePath, { foreignCode });
		const { sources, envSources } = repoConfig.resolveLayeredProvenance(resolved, project, layers);
		const configPath = worktreePath || project.path;
		return {
			// `null`, not `undefined`, for unset keys: JSON.stringify drops
			// `undefined`, which would hide a settable key from `dev3 config show`.
			settings: Object.fromEntries(
				DEV3_REPO_CONFIG_KEYS.map((key) => [key, (resolved as any)[key] ?? null]),
			),
			sources,
			envSources,
			layers: layers.map(({ id, path, exists, trusted }) => ({ id, path, exists, trusted })),
			hasRepoConfig: repoConfig.hasRepoConfig(configPath),
			// The file may exist and still be irrelevant — say so rather than
			// letting "exists" imply its values are in the table above.
			repoConfigIgnored: !repoConfigEnabled(project),
		};
	},

	"config.set": async (params) => editConfigKey(params, "set"),
	"config.unset": async (params) => editConfigKey(params, "unset"),

	// Mint a fresh access URL (with a one-time QR token) for a running headless
	// server. The JWT secret lives only in this process, so a detached
	// `dev3 remote url` can't mint a token itself — it asks us over this socket.
	// Only meaningful in headless mode; a GUI instance has no remote-access
	// server bound, so serverPort is 0 and we say so plainly.
	//
	// The remote-access-server / cloudflare-tunnel modules pull in the electrobun
	// platform shim, so we import them LAZILY here: a static import would drag
	// electrobun into every unit test that merely imports this socket server.
	"remote.accessUrl": async () => {
		const { getAccessUrl, getServerPort, getStaticCode, getSignInLink } = await import("../remote-access-server");
		const { getTunnelUrl } = await import("../cloudflare-tunnel");
		if (getServerPort() === 0) {
			throw new Error("Remote access server is not running in this instance (start it with `dev3 remote`).");
		}
		return {
			url: await getAccessUrl(),
			tunnelUrl: getTunnelUrl(),
			port: getServerPort(),
			staticCode: getStaticCode(),
			signInLink: await getSignInLink(),
		};
	},

	// `dev3 update` on a box with a running headless server DELEGATES here rather
	// than updating the files itself, and that is the whole point: only this process
	// can hand its port and its live cloudflared to the successor. A separate CLI
	// process doing the swap would leave this server running an install that is no
	// longer on disk, and the next restart would change the public URL.
	"remote.selfUpdate": async (params) => {
		const { runSelfUpdate } = await import("../self-update");
		const { loadSettings } = await import("../settings");
		const channel = (await loadSettings()).updateChannel;
		const dryRun = Boolean((params as { dryRun?: boolean } | undefined)?.dryRun);
		if (dryRun) {
			const { buildPlan } = await import("../self-update");
			const { install, plan, runningVersion, summary } = await buildPlan(channel);
			return {
				ok: plan.kind !== "refused",
				restarting: false,
				message: summary,
				install,
				kind: plan.kind,
				runningVersion,
				// The OFFERED build, so `dev3 update --check` can print it without planning
				// a second time in a process whose install method is a different one.
				version: plan.kind === "brew" || plan.kind === "tarball" ? plan.version : null,
				channel,
			};
		}
		return await runSelfUpdate({ channel, restart: true });
	},
};

/** Project, worktree and trust of the checkout a `dev3 config` call targets. */
async function configTarget(params: Record<string, unknown>): Promise<{ project: Project; worktreePath?: string; foreignCode: boolean }> {
	const projectId = params.projectId as string;
	if (!projectId) throw new Error("projectId is required");
	const project = await data.getProject(projectId);
	if (project.kind === "virtual") throw new Error("Operations boards have no .dev3 config files.");
	const worktreePath = (params.worktreePath as string | undefined) || undefined;
	let foreignCode = false;
	if (typeof params.taskId === "string" && params.taskId) {
		try {
			foreignCode = (await data.loadTasks(project)).find((t) => t.id === params.taskId)?.foreignCode === true;
		} catch {
			// Unknown task: treat its worktree as the user's own, like a launch would.
		}
	}
	return { project, worktreePath, foreignCode };
}

/**
 * `dev3 config set|unset`: one key (or `key.entry`) in one file. `local`
 * picks config.local.json; `main` picks the project root instead of the task
 * worktree. The CLI has already parsed the value against the schema; the
 * whole file is validated again here before anything is written.
 */
async function editConfigKey(params: Record<string, unknown>, mode: "set" | "unset") {
	const { project, worktreePath, foreignCode } = await configTarget(params);
	if (!repoConfigEnabled(project)) {
		throw new Error("Repository dev3 configuration is disabled for this project — enable \"Use repository dev3 configuration\" in Project Settings first.");
	}
	const { key, sub } = resolveConfigPath(String(params.key ?? ""));
	const local = params.local === true;
	const base = params.main === true || !worktreePath ? project.path : worktreePath;
	// A reviewed branch must not reach the trusted checkout's commands through its agent.
	if (foreignCode && base !== worktreePath && COMMAND_BEARING_CONFIG_KEYS.has(key)) {
		throw new Error(`${key} can run code, and this task holds foreign code: set it from the project's own checkout or Project Settings, not from this worktree.`);
	}
	const file = repoConfig.configFilePath(base, local);
	let edit: { previous: unknown; value: unknown };
	try {
		edit = repoConfig.editConfigFile(file, key, sub, mode === "set" ? params.value : undefined);
	} catch (err) {
		if (err instanceof repoConfig.ConfigEditError) throw new Error(err.message);
		throw err;
	}
	if (local) await repoConfig.ensureGitignore(base);
	const layers = repoConfig.listConfigLayers(project, worktreePath, { foreignCode });
	const { shadowedBy, ignoredAsForeign } = repoConfig.describeEditReach(layers, file, key, sub);
	getPushMessage()?.("projectUpdated", { project: await repoConfig.resolveProjectConfig(project) });
	return { file, ...edit, shadowedBy, ignoredAsForeign };
}
