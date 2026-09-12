import type { CliResponse, DevServerEntry, DevServerStatus } from "../../shared/types";
import { DEV_SERVER_LOG_DEFAULT_LINES, DEV_SERVER_LOG_MAX_LINES } from "../../shared/dev-server-log";
import { readDevServerLogTail } from "../../bun/dev-server-log";
import { CLI_EXIT_CODE_DEV_SERVER_ENV_INVALID, CLI_EXIT_CODE_DEV_SERVER_NAME_REQUIRED } from "../../shared/cli-exit-codes";
import { parseDevServerEnvPair } from "../../shared/dev-server-env";
import { DEV_SERVER_NAME_PATTERN, DEV_SERVER_NAME_REQUIRED_CODE } from "../../shared/dev-servers";
import { isInstanceLossError, sendRequest } from "../socket-client";
import { printDetail, exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { discoverSocketExcluding, expandShortId, resolveProjectId, type CliContext } from "../context";

const WAIT_POLL_MS = 500;
const WAIT_DEFAULT_TIMEOUT_S = 120;
/** How long `--wait` keeps polling for an assigned port once some other port is up. */
const WAIT_ASSIGNED_GRACE_MS = 10_000;

/**
 * devServer.* transport with instance failover. The instance serving a
 * stop/restart can die mid-request when the target dev session hosts a dev3
 * app of its own (dev-3.0 dogfooding: `bun run dev` boots dev-3.0 inside
 * dev-3.0) — the teardown reaps the responder itself, so the reply never
 * arrives and every reconnect to the same socket is refused (#910/#920). All
 * devServer.* ops are idempotent, so on such an instance loss we re-discover
 * (excluding the dead socket) and replay once against a surviving instance —
 * typically the primary app, which also finishes any teardown the dying
 * instance left incomplete. `socketRef` is updated in place so follow-up
 * requests (e.g. --wait status polls) stick to the surviving instance.
 */
async function sendWithInstanceFailover(
	socketRef: { current: string },
	method: string,
	params: Record<string, unknown>,
): Promise<CliResponse> {
	try {
		return await sendRequest(socketRef.current, method, params, { retryEmptyResponse: true });
	} catch (err) {
		if (!isInstanceLossError(err)) throw err;
		const fallback = discoverSocketExcluding([socketRef.current]);
		if (!fallback || fallback === socketRef.current) throw err;
		process.stderr.write(
			`note: the app instance serving this command went away mid-request; retrying via ${fallback}\n`,
		);
		socketRef.current = fallback;
		return await sendRequest(fallback, method, params, { retryEmptyResponse: true });
	}
}

/**
 * Coerce a raw `devServer.*` RPC payload into a DevServerStatus with every
 * array field guaranteed present. Guards against version skew: the `dev3` CLI
 * and the running app are versioned independently, so a CLI newer than the app
 * receives a status shaped the way that older backend sent it — one flat server
 * rather than a list. Without this, the rendering helpers below dereference
 * `undefined.length` and the whole command crashes instead of printing a status.
 */
function asStatus(data: unknown): DevServerStatus {
	const raw = (data ?? {}) as DevServerStatus & Partial<DevServerEntry>;
	const servers = raw.servers ?? [legacyEntry(raw)];
	return {
		...raw,
		assignedPorts: raw.assignedPorts ?? [],
		namedPorts: raw.namedPorts ?? {},
		ports: raw.ports ?? [],
		configErrors: raw.configErrors ?? [],
		servers: servers.map(normalizeEntry),
	};
}

/** One server out of a pre-multi-server backend's flat status. */
function legacyEntry(raw: DevServerStatus & Partial<DevServerEntry>): DevServerEntry {
	return normalizeEntry({
		name: "dev",
		title: "Dev Server",
		isDefault: true,
		running: raw.running === true,
		devSessionName: (raw as { devSessionName?: string }).devSessionName ?? "",
		viewerPaneId: raw.viewerPaneId ?? null,
		panePids: raw.panePids ?? [],
		namedPorts: {},
		logPath: raw.logPath ?? null,
		devPorts: raw.devPorts ?? [],
		publishedPorts: raw.publishedPorts ?? [],
		portConflicts: raw.portConflicts ?? [],
		extraEnvKeys: raw.extraEnvKeys ?? [],
		resourceUsage: raw.resourceUsage,
	});
}

function normalizeEntry(entry: DevServerEntry): DevServerEntry {
	return {
		...entry,
		panePids: entry.panePids ?? [],
		namedPorts: entry.namedPorts ?? {},
		logPath: entry.logPath ?? null,
		devPorts: entry.devPorts ?? [],
		publishedPorts: entry.publishedPorts ?? [],
		portConflicts: entry.portConflicts ?? [],
		extraEnvKeys: entry.extraEnvKeys ?? [],
	};
}

/**
 * Collect every `--env KEY=VALUE`. A rejected pair aborts the whole command with
 * its own exit code: starting the server minus one variable would look like a
 * success and boot the wrong configuration.
 *
 * Later wins on a repeated key, matching how a shell treats two assignments.
 */
function collectEnvFlag(args: ParsedArgs, action: string): Record<string, string> | undefined {
	const raw = args.repeated?.env;
	if (!raw || raw.length === 0) return undefined;
	const env: Record<string, string> = {};
	for (const item of raw) {
		if (item === "true") {
			exitError(
				`--env needs a KEY=VALUE argument`,
				`Example: dev3 dev-server ${action} --env DEV3_QA_SCOPE=seeded`,
				CLI_EXIT_CODE_DEV_SERVER_ENV_INVALID,
			);
		}
		const parsed = parseDevServerEnvPair(item);
		if ("error" in parsed) {
			exitError(
				`--env rejected: ${parsed.error}`,
				"Nothing was started. dev3 sets PATH, HOME, SHELL, DEV3_TASK_ID, DEV3_WORKTREE_ROOT\n"
				+ "and every DEV3_PORT* itself — those cannot be overridden.",
				CLI_EXIT_CODE_DEV_SERVER_ENV_INVALID,
			);
		}
		env[parsed.key] = parsed.value;
	}
	return env;
}

/** A positional that can only be a task: `seq:<N>`, a UUID, or a hex id prefix. */
function looksLikeTaskRef(raw: string): boolean {
	return /^seq:\d+$/.test(raw) || /^[0-9a-f-]{6,}$/i.test(raw);
}

/**
 * Which task and which dev server the command is about.
 *
 * The positional argument has meant a task id since this command existed, and
 * still does when it looks like one. A dev server's name (lowercase letters,
 * digits and dashes — `api`, `back-office`) cannot be confused with a task id,
 * so it may be written plainly; `--server` settles the rare overlap of a server
 * whose name is also hex, such as `abcdef`.
 */
function resolveTarget(args: ParsedArgs, context: CliContext | null): { taskId?: string; server?: string } {
	const positionals = args.positional.filter((value) => value.length > 0);
	const flagServer = args.flags.server;
	let taskRef = args.flags.id;
	let server = typeof flagServer === "string" && flagServer !== "true" ? flagServer : undefined;
	for (const value of positionals) {
		if (!taskRef && looksLikeTaskRef(value)) taskRef = value;
		else if (!server) server = value;
		else exitUsage(`Unexpected argument: ${value}`);
	}
	if (server && !DEV_SERVER_NAME_PATTERN.test(server)) {
		exitUsage(`"${server}" is not a valid dev server name (lowercase letters, digits and dashes)`);
	}
	const raw = taskRef || context?.taskId;
	return { taskId: raw ? expandShortId(raw, context) : undefined, server };
}

function formatAssignedPorts(status: DevServerStatus): string {
	if (status.assignedPorts.length === 0) return "(none allocated)";
	const named = new Map(Object.entries(status.namedPorts).map(([name, port]) => [port, name]));
	return status.assignedPorts
		.map((port, index) => {
			const name = named.get(port);
			return name ? `DEV3_PORT_${name.toUpperCase().replaceAll("-", "_")}=${port}` : `DEV3_PORT${index}=${port}`;
		})
		.join(", ");
}

function formatPortInfos(ports: DevServerStatus["ports"]): string {
	if (ports.length === 0) return "(none detected)";
	return ports.map((port) => `${port.port} (${port.processName} pid ${port.pid})`).join(", ");
}

function formatPids(entry: DevServerEntry): string {
	if (entry.panePids.length === 0) return "(none)";
	return entry.panePids.join(", ");
}

function actedOn(status: DevServerStatus, server?: string, all?: boolean): string {
	if (all) return status.servers.map((entry) => entry.name).join(", ") || "(none)";
	return server ?? status.servers.find((entry) => entry.isDefault)?.name ?? status.servers[0]?.name ?? "dev";
}

function printStatusLine(action: string, status: DevServerStatus, server?: string, all?: boolean): void {
	const shortTaskId = status.taskId.slice(0, 8);
	const names = actedOn(status, server, all);
	switch (action) {
		case "start":
			process.stdout.write(`Started dev server ${names} for task ${shortTaskId}\n`);
			return;
		case "restart":
			process.stdout.write(`Restarted dev server ${names} for task ${shortTaskId}\n`);
			return;
		case "stop":
			process.stdout.write(`Stopped dev server ${names} for task ${shortTaskId}\n`);
			return;
		default:
			if (status.tmuxError) {
				process.stdout.write(`Dev server status is unknown for task ${shortTaskId} (tmux could not be reached)\n`);
				return;
			}
			// One declared server keeps the sentence it has always printed; several
			// need a count, because "running" is no longer one fact.
			if (status.servers.length <= 1) {
				process.stdout.write(`Dev server is ${status.running ? "running" : "stopped"} for task ${shortTaskId}\n`);
				return;
			}
			process.stdout.write(
				`${status.servers.filter((entry) => entry.running).length} of ${status.servers.length}`
				+ ` dev servers running for task ${shortTaskId}\n`,
			);
	}
}

function printStatusDetails(status: DevServerStatus): void {
	// A native task hosts each dev server in a pane of its own terminal, so it has
	// no tmux session and no socket to report.
	const native = status.backend === "native";
	printDetail([
		["Task:", status.taskId.slice(0, 8)],
		["Backend:", status.backend],
		...(native ? [] : [["Socket:", status.tmuxSocket] as [string, string]]),
		["Worktree:", status.worktreePath ?? "(none)"],
		["Assigned Ports:", formatAssignedPorts(status)],
		["Detected Ports:", formatPortInfos(status.ports)],
	]);
	for (const entry of status.servers) {
		process.stdout.write(`\n${entry.name}${entry.isDefault ? " (default)" : ""}\n`);
		printDetail([
			["State:", status.tmuxError ? "unknown (tmux unavailable)" : entry.running ? "running" : "stopped"],
			...(native ? [] : [["Session:", entry.devSessionName] as [string, string]]),
			["Pane:", entry.viewerPaneId ?? "(none)"],
			["Output Log:", entry.logPath ?? "(none)"],
			["Pane PIDs:", formatPids(entry)],
			...(Object.keys(entry.namedPorts).length > 0
				? [["Named Ports:", Object.entries(entry.namedPorts).map(([name, port]) => `${name}=${port}`).join(", ")] as [string, string]]
				: []),
			["Dev Ports:", formatPortInfos(entry.devPorts)],
			// Only worth a line when something actually published for this server —
			// otherwise it is noise on every ordinary dev server.
			...(entry.publishedPorts.length > 0
				? [["Published Ports:", formatPortInfos(entry.publishedPorts)] as [string, string]]
				: []),
			// Names only. A value passed with --env can be a token, and this output ends
			// up in transcripts, screenshots and CI logs.
			...(entry.extraEnvKeys.length > 0
				? [["Extra Env:", entry.extraEnvKeys.join(", ")] as [string, string]]
				: []),
			...(entry.resourceUsage
				? [
					["CPU:", String(entry.resourceUsage.cpu)] as [string, string],
					["Memory:", String(entry.resourceUsage.rss)] as [string, string],
				]
				: []),
		]);
		printPortConflicts(entry);
	}
	for (const problem of status.configErrors) {
		process.stdout.write(`WARNING: dev server config: ${problem}\n`);
	}
	if (status.tmuxError) {
		process.stdout.write(`WARNING: ${status.tmuxError}\n`);
	}
}

function printPortConflicts(entry: DevServerEntry): void {
	for (const conflict of entry.portConflicts) {
		process.stdout.write(
			`WARNING: port ${conflict.port} is already in use by ${conflict.processName} (pid ${conflict.pid}) — not owned by this dev server\n`,
		);
	}
}

/**
 * Ports that count as "the dev server is up": bound by its own process tree, or
 * published for it by another process after it started (a containerised
 * devScript has its ports published by the container runtime's daemon, which is
 * never a descendant of the pane — see issue #1427).
 */
function readyPorts(entries: DevServerEntry[]): DevServerStatus["ports"] {
	const byPort = new Map<number, DevServerStatus["ports"][number]>();
	for (const entry of entries) {
		for (const info of [...entry.devPorts, ...entry.publishedPorts]) {
			if (!byPort.has(info.port)) byPort.set(info.port, info);
		}
	}
	return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/** The ports `--wait` waits for: the servers' own named ports, else the task's. */
function waitedPorts(status: DevServerStatus, watched: DevServerEntry[]): Set<number> {
	const own = watched.flatMap((entry) => Object.values(entry.namedPorts));
	return new Set(own.length > 0 ? own : status.assignedPorts);
}

/**
 * Poll `devServer.status` until the watched servers are LISTENing on a port
 * assigned to them (`DEV3_PORT*`, or their own `DEV3_PORT_<NAME>`) — the port
 * the caller is about to curl. With verified teardown on stop/restart the old
 * server is confirmed dead first, so a bound port here really is the NEW server
 * — not a stale process still serving the previous build.
 *
 * A dev server that opens auxiliary ports before its assigned one (a bundler's
 * HMR socket, a sidecar) used to satisfy the wait immediately, so the caller's
 * curl against `$DEV3_PORT0` raced the real listener. Once any port is up we
 * therefore keep polling for an assigned one for `WAIT_ASSIGNED_GRACE_MS`, then
 * accept what is listening: a devScript is free to bind a fixed port and ignore
 * the pool, and hanging on that project until the timeout would be worse than a
 * slightly early ready.
 */
async function waitForDevServerReady(
	socketRef: { current: string },
	params: Record<string, unknown>,
	timeoutSec: number,
	watch: string[],
): Promise<void> {
	process.stdout.write(`Waiting for ${watch.join(", ")} to open a port (timeout ${timeoutSec}s)...\n`);
	const timeoutMs = timeoutSec * 1000;
	let anyReadyAt: number | null = null;
	for (let waited = 0; ; waited += WAIT_POLL_MS) {
		// A status read is idempotent, and the poll can straddle the tail of the
		// socket handoff — retry an empty response instead of aborting the wait.
		const resp = await sendWithInstanceFailover(socketRef, "devServer.status", params);
		if (!resp.ok) exitError(resp.error || "Failed to poll dev server status");
		const status = asStatus(resp.data);
		if (status.tmuxError) {
			exitError(status.tmuxError);
		}
		const watched = status.servers.filter((entry) => watch.includes(entry.name));
		if (!watched.some((entry) => entry.running)) {
			exitError("Dev server exited before opening a port — check the dev server pane for errors");
		}
		const ready = readyPorts(watched);
		const assigned = waitedPorts(status, watched);
		const assignedReady = ready.filter((p) => assigned.has(p.port));
		if (assignedReady.length > 0) {
			process.stdout.write(`Ready: listening on ${assignedReady.map((p) => p.port).join(", ")}\n`);
			return;
		}
		if (ready.length > 0 && anyReadyAt === null) {
			anyReadyAt = waited;
			if (assigned.size > 0) {
				process.stdout.write(
					`Listening on ${ready.map((p) => p.port).join(", ")}, but not yet on the assigned`
					+ ` ${[...assigned].join(", ")} — waiting up to ${WAIT_ASSIGNED_GRACE_MS / 1000}s more...\n`,
				);
			}
		}
		const graceExpired = anyReadyAt !== null && waited - anyReadyAt >= WAIT_ASSIGNED_GRACE_MS;
		if (ready.length > 0 && (assigned.size === 0 || graceExpired || waited >= timeoutMs)) {
			process.stdout.write(
				`Ready: listening on ${ready.map((p) => p.port).join(", ")}`
				+ (assigned.size > 0
					? ` — the assigned ${[...assigned].join(", ")} never came up, so $DEV3_PORT* is probably not what this devScript binds`
					: "")
				+ "\n",
			);
			return;
		}
		if (waited >= timeoutMs) {
			// A squatted assigned port is the likeliest reason the devScript never
			// got to listen — say so instead of only "build still in progress?".
			const squatted = watched
				.flatMap((entry) => entry.portConflicts)
				.map((c) => `${c.port} held by ${c.processName} (pid ${c.pid})`)
				.join("; ");
			exitError(
				`Dev server did not open a port within ${timeoutSec}s (build still in progress?)`
				+ (squatted ? ` — assigned port(s) taken by another process: ${squatted}` : ""),
			);
		}
		await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
	}
}

function parseWaitTimeout(args: ParsedArgs): number {
	const raw = args.flags.timeout;
	if (raw === undefined) return WAIT_DEFAULT_TIMEOUT_S;
	const parsed = parseInt(raw, 10);
	if (isNaN(parsed) || parsed <= 0) {
		exitUsage(`Invalid --timeout value: ${raw} (expected a positive number of seconds)`);
	}
	return parsed;
}

async function runAction(
	action: "start" | "stop" | "restart" | "status",
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	const { taskId, server } = resolveTarget(args, context);
	if (!taskId) {
		exitUsage(`Usage: dev3 dev-server ${action} [task-id] [server-name]`);
	}
	const all = args.flags.all !== undefined;
	if (all && server) {
		exitUsage(`dev-server ${action} takes either a server name or --all, not both`);
	}

	const params: Record<string, unknown> = { taskId };
	const projectId = resolveProjectId(args.flags.project, context);
	if (projectId) params.projectId = projectId;
	if (server) params.server = server;
	if (all && action !== "status") params.all = true;

	if (action === "start" || action === "restart") {
		const env = collectEnvFlag(args, action);
		if (env) params.env = env;
	} else if (args.repeated?.env) {
		exitUsage(`dev-server ${action} takes no --env (only start and restart do)`);
	}

	// stop/restart tear the dev tmux session down; the app can drop this in-flight
	// connection mid-handoff and close it with no reply ("Empty response"). Every
	// devServer.* op is idempotent (start/restart re-kill any live session first;
	// stop/status are no-ops when already gone), so a short replay window turns a
	// false failure into the real status instead of a stopped-but-not-restarted
	// server the caller must recover by hand. When the serving instance itself
	// dies, sendWithInstanceFailover replays through a surviving instance.
	const socketRef = { current: socketPath };
	const resp = await sendWithInstanceFailover(socketRef, `devServer.${action}`, params);
	if (!resp.ok) failAction(action, resp.error);

	const status = asStatus(resp.data);
	printStatusLine(action, status, server, all);
	printStatusDetails(status);

	if ((action === "start" || action === "restart") && args.flags.wait !== undefined) {
		// Poll without `env`: the values are already delivered, and re-sending a
		// possibly-secret value on every 500ms status read buys nothing.
		const { env: _env, server: _server, all: _all, ...statusParams } = params;
		const watch = all
			? status.servers.map((entry) => entry.name)
			: [actedOn(status, server, false)];
		await waitForDevServerReady(socketRef, statusParams, parseWaitTimeout(args), watch);
	}
}

/**
 * Print the tail of one dev server's own output.
 *
 * The status read gives the path; the file is read locally, because piping a
 * 32 MB log through the socket to print 200 lines of it would be absurd. A file
 * that is not there yet is a plain statement, not an error — a dev server that
 * has never run has nothing to say, and exiting non-zero would make a perfectly
 * ordinary state look like a failure.
 */
async function runLogs(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	const { taskId, server } = resolveTarget(args, context);
	if (!taskId) exitUsage("Usage: dev3 dev-server logs [task-id] [server-name] [--lines N]");

	const lines = parseLogLines(args);
	const params: Record<string, unknown> = { taskId };
	const projectId = resolveProjectId(args.flags.project, context);
	if (projectId) params.projectId = projectId;

	const socketRef = { current: socketPath };
	const resp = await sendWithInstanceFailover(socketRef, "devServer.status", params);
	if (!resp.ok) failAction("read", resp.error);
	const status = asStatus(resp.data);
	// One log per server, so an unnamed call has to resolve exactly like a start.
	const entry = server
		? status.servers.find((candidate) => candidate.name === server)
		: status.servers.find((candidate) => candidate.isDefault) ?? (status.servers.length === 1 ? status.servers[0] : undefined);
	if (!entry) {
		const names = status.servers.map((candidate) => candidate.name).join(", ");
		exitError(
			server
				? `no dev server named "${server}" — this project declares: ${names || "none"}`
				: `this project declares several dev servers and none of them is the default — name one: ${names}`,
			undefined,
			CLI_EXIT_CODE_DEV_SERVER_NAME_REQUIRED,
		);
		return;
	}
	if (!entry.logPath) {
		exitError("This task has no worktree, so its dev server has no log file.");
		return;
	}

	const tail = readDevServerLogTail(entry.logPath, lines);
	if (!tail.exists) {
		process.stdout.write(
			`No dev-server output captured yet for ${entry.name} on task ${status.taskId.slice(0, 8)}.\n`
			+ `It will appear at ${entry.logPath} once the dev server runs.\n`,
		);
		return;
	}
	process.stdout.write(`${entry.logPath} (${tail.bytes} bytes, last ${lines} lines)\n`);
	if (tail.text) process.stdout.write(`${tail.text}\n`);
}

function parseLogLines(args: ParsedArgs): number {
	const raw = args.flags.lines;
	if (raw === undefined) return DEV_SERVER_LOG_DEFAULT_LINES;
	const parsed = parseInt(raw, 10);
	if (isNaN(parsed) || parsed <= 0) {
		exitUsage(`Invalid --lines value: ${raw} (expected a positive number)`);
	}
	if (parsed > DEV_SERVER_LOG_MAX_LINES) {
		exitUsage(`--lines is capped at ${DEV_SERVER_LOG_MAX_LINES}; grep the file directly for more.`);
	}
	return parsed;
}

/**
 * "Which server did you mean?" gets its own exit code so a script can fix the
 * call — every other failure stays a plain command failure.
 */
function failAction(action: string, error?: string): never {
	const message = error || `Failed to ${action} dev server`;
	if (message.startsWith(DEV_SERVER_NAME_REQUIRED_CODE)) {
		exitError(
			message.slice(DEV_SERVER_NAME_REQUIRED_CODE.length + 2),
			`Name one of them, or act on all of them: dev3 dev-server ${action} --all`,
			CLI_EXIT_CODE_DEV_SERVER_NAME_REQUIRED,
		);
	}
	exitError(message);
}

export async function handleDevServer(
	subcommand: string | undefined,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	switch (subcommand) {
		case undefined:
		case "status":
			return runAction("status", args, socketPath, context);
		case "start":
			return runAction("start", args, socketPath, context);
		case "stop":
			return runAction("stop", args, socketPath, context);
		case "restart":
			return runAction("restart", args, socketPath, context);
		case "logs":
			return runLogs(args, socketPath, context);
		default:
			exitUsage(
				`Unknown subcommand: dev-server ${subcommand}` +
				"\nAvailable: dev-server start, dev-server stop, dev-server restart, dev-server status, dev-server logs",
			);
	}
}
