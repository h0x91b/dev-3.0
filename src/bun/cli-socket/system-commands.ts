import { DEV3_REPO_CONFIG_KEYS, repoConfigEnabled } from "../../shared/types";
import * as data from "../data";
import { loadSpacesFile } from "../spaces-data";
import { getPushMessageLocal } from "../rpc-handlers";
import { getDevServerStatus, runDevServer, stopDevServer, restartDevServer } from "../rpc-handlers/tmux-pty";
import { NATIVE_PROMPT_DELIVERY_METHOD, deliverNativePromptAsOwner } from "../agent-prompt-native";
import { NATIVE_PANE_INPUT_METHOD, runNativePaneInputAsOwner } from "../pane-input-native";
import type { PaneInputProgram } from "../../shared/pane-input";
import * as repoConfig from "../repo-config";
import { log, type Handler } from "./shared";
import { readEnvParam, readServerParams, resolveTaskFromParams } from "./task-resolution";

export const systemHandlers: Record<string, Handler> = {
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
		const projectId = params.projectId as string;
		if (!projectId) throw new Error("projectId is required");
		const worktreePath = params.worktreePath as string | undefined;
		const project = await data.getProject(projectId);
		const configPath = worktreePath || project.path;
		const resolved = await repoConfig.resolveProjectConfig(project, configPath);
		// Full provenance for every key (local/repo/project/default/unset) — the CLI
		// renders it verbatim, so it never has to guess a blanket "global" fallback
		// that would hide whether a value is a real default, a project setting, or
		// genuinely unset. Wider than getConfigSources (repo/local, for the UI badge).
		const provenance = repoConfig.resolveConfigProvenance(resolved, project, configPath);
		const hasRepoFile = repoConfig.hasRepoConfig(configPath);
		return {
			// Map unset fields (no value at any layer and no default — e.g. portCount)
			// to `null` rather than leaving them `undefined`: JSON.stringify drops
			// `undefined` properties, which would silently hide a valid, settable
			// config key from `dev3 config show` and make it undiscoverable. `null`
			// survives serialization and the CLI renders it as "(not set)".
			settings: Object.fromEntries(
				DEV3_REPO_CONFIG_KEYS.map((key) => [key, (resolved as any)[key] ?? null]),
			),
			sources: provenance,
			hasRepoConfig: hasRepoFile,
			// The file may exist and still be irrelevant — say so rather than
			// letting "exists" imply its values are in the table above.
			repoConfigIgnored: !repoConfigEnabled(project),
		};
	},

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
