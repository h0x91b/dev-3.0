import { rmSync } from "node:fs";
import type { OpenCodeLaunchSpec } from "../shared/agent-adapters/opencode";
import { buildOpenCodeTuiCommand, openCodeBinary, validateOpenCodeTuiArgs } from "../shared/agent-adapters/opencode";
import { unregisterPreparationSpawn } from "./preparation-runtime";
import { terminatePidsVerified, waitForPidsGone } from "./process-reaper";
import { writeLaunchScript } from "./rpc-handlers/shared-pure";
import { spawn } from "./spawn";
import { runBounded } from "./tmux/bounded-spawn";

const STARTUP_TIMEOUT_MS = 12_000;
const HTTP_REQUEST_TIMEOUT_MS = 15_000;
const SERVER_TERM_GRACE_MS = 1_500;
const SERVER_KILL_WAIT_MS = 2_000;

interface OpenCodeServer {
	url: string;
	password: string;
}

/** One task/session-scoped `opencode serve`, owned until its termination is verified. */
interface ServerOwner {
	taskId: string;
	controller: AbortController;
	ready: Promise<OpenCodeServer>;
	child?: ReturnType<typeof spawn>;
	prompt?: Promise<void>;
	scripts: Set<string>;
	stopping?: Promise<void>;
}

const owners = new Map<string, ServerOwner>();
const stoppingTasks = new Set<string>();
let shuttingDown = false;

export interface PreparedOpenCodeLaunch {
	command: string;
	sessionId: string;
	/** For the TUI: OpenCode reads OPENCODE_PASSWORD first, so an inherited one must not win. */
	passwordEnv: { OPENCODE_PASSWORD: string; OPENCODE_SERVER_PASSWORD: string };
}

function ownerKey(taskId: string, sessionId: string): string {
	return `${taskId}\0${sessionId}`;
}

function assertLive(owner: ServerOwner): void {
	if (owner.controller.signal.aborted) throw new Error("OpenCode server operation was cancelled because its owner is stopping.");
}

async function request(server: OpenCodeServer, path: string, signal: AbortSignal, init: RequestInit = {}, timeoutMs = HTTP_REQUEST_TIMEOUT_MS): Promise<Response> {
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(new Error(`OpenCode HTTP request to ${path} exceeded its deadline.`)), timeoutMs);
	try {
		return await fetch(`${server.url}${path}`, {
			...init,
			headers: {
				Authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}`,
				"Content-Type": "application/json",
			},
			signal: AbortSignal.any([signal, deadline.signal]),
		});
	} finally {
		clearTimeout(timer);
	}
}

async function requestJson<T>(server: OpenCodeServer, path: string, signal: AbortSignal, init: RequestInit): Promise<T> {
	const response = await request(server, path, signal, init);
	if (!response.ok) throw new Error(`OpenCode V2 request failed (${response.status}) at ${path}.`);
	return await response.json() as T;
}

async function terminate(child: ReturnType<typeof spawn>): Promise<void> {
	if (process.platform === "win32") {
		const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
		const taskkill = systemRoot ? `${systemRoot}\\System32\\taskkill.exe` : "taskkill.exe";
		const runTaskkill = async (force: boolean): Promise<boolean> => {
			const proc = spawn([taskkill, "/T", "/PID", String(child.pid), ...(force ? ["/F"] : [])], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
			const result = await runBounded(proc, { timeoutMs: 5_000 });
			return result.kind === "done" && result.value.exitCode === 0;
		};
		const requested = await runTaskkill(false);
		await new Promise((resolve) => setTimeout(resolve, SERVER_TERM_GRACE_MS));
		const forced = await runTaskkill(true);
		if (!forced && !requested) throw new Error(`Could not verify termination of OpenCode process tree ${child.pid}.`);
		if ((await waitForPidsGone([child.pid], SERVER_KILL_WAIT_MS, 100)).length > 0) {
			throw new Error(`OpenCode process tree ${child.pid} survived forced termination.`);
		}
		return;
	}
	const survivors = await terminatePidsVerified([-child.pid], { termGraceMs: SERVER_TERM_GRACE_MS, killWaitMs: SERVER_KILL_WAIT_MS });
	if (survivors.length > 0) throw new Error(`OpenCode process group ${child.pid} survived SIGKILL; ownership is retained.`);
}

async function reservePort(): Promise<number> {
	const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
	const port = probe.port;
	await probe.stop(true);
	if (!port) throw new Error("Could not reserve a loopback port for the OpenCode V2 server.");
	return port;
}

async function startServer(owner: ServerOwner, binary: string, cwd: string, env: Record<string, string>): Promise<OpenCodeServer> {
	const port = await reservePort();
	assertLive(owner);
	const server = { url: `http://127.0.0.1:${port}`, password: crypto.randomUUID() };
	const child = spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
		cwd,
		env: { ...env, OPENCODE_PASSWORD: server.password },
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		detached: process.platform !== "win32",
	});
	owner.child = child;
	const exited = child.exited.then((code) => ({ code }));
	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		assertLive(owner);
		const probe = request(server, "/api/info", owner.controller.signal, {}, Math.min(1_000, deadline - Date.now()))
			.then((response) => response.ok, () => false);
		const result = await Promise.race([probe, exited]);
		if (typeof result === "object") throw new Error(`OpenCode server exited during startup (code ${result.code ?? "unknown"}).`);
		if (result) {
			assertLive(owner);
			// A long-lived server must not hold the task's preparation open.
			unregisterPreparationSpawn(owner.taskId, child.pid);
			return server;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("OpenCode V2 server did not become ready within 12 seconds.");
}

function stopOwner(owner: ServerOwner): Promise<void> {
	owner.stopping ??= (async () => {
		owner.controller.abort();
		await Promise.allSettled([owner.ready, owner.prompt]);
		if (owner.child) await terminate(owner.child);
		for (const [key, entry] of owners) if (entry === owner) owners.delete(key);
		for (const path of owner.scripts) rmSync(path, { force: true });
	})().finally(() => { owner.stopping = undefined; });
	return owner.stopping;
}

/**
 * Starts (or reuses) the server for one pane and creates its session, or checks the
 * saved one on resume. The prompt is not sent here: see `startOpenCodePrompt`.
 */
export async function prepareOpenCodeLaunch(input: {
	taskId: string;
	baseCommand: string;
	cwd: string;
	env: Record<string, string>;
	spec: OpenCodeLaunchSpec;
}): Promise<PreparedOpenCodeLaunch> {
	const binary = openCodeBinary(input.baseCommand);
	validateOpenCodeTuiArgs(input.spec.additionalArgs);
	if (shuttingDown || stoppingTasks.has(input.taskId)) throw new Error("OpenCode server owner is stopping; refusing a new launch.");
	const saved = input.spec.sessionId;
	const key = ownerKey(input.taskId, saved ?? `pending-${crypto.randomUUID()}`);
	let owner = owners.get(key);
	const createdHere = !owner;
	if (!owner) {
		owner = { taskId: input.taskId, controller: new AbortController(), scripts: new Set() } as ServerOwner;
		owner.ready = startServer(owner, binary, input.cwd, input.env);
		owners.set(key, owner);
	}
	try {
		const server = await owner.ready;
		assertLive(owner);
		let sessionId: string;
		if (saved) {
			const response = await request(server, `/api/session/${encodeURIComponent(saved)}`, owner.controller.signal);
			if (!response.ok) throw new Error(`Saved OpenCode session ${saved} is unavailable (${response.status}); no other session was selected.`);
			sessionId = saved;
		} else {
			const created = await requestJson<{ data?: { id?: string } }>(server, "/api/session", owner.controller.signal, {
				method: "POST",
				body: JSON.stringify({
					location: { directory: input.cwd },
					...(input.spec.agent ? { agent: input.spec.agent } : {}),
					...(input.spec.model ? { model: input.spec.model } : {}),
				}),
			});
			if (!created.data?.id) throw new Error("OpenCode V2 created a session without returning its session ID.");
			sessionId = created.data.id;
		}
		assertLive(owner);
		if (!saved) {
			owners.delete(key);
			owners.set(ownerKey(input.taskId, sessionId), owner);
		}
		return {
			command: buildOpenCodeTuiCommand(binary, input.spec.additionalArgs, server.url, sessionId),
			sessionId,
			passwordEnv: { OPENCODE_PASSWORD: server.password, OPENCODE_SERVER_PASSWORD: server.password },
		};
	} catch (error) {
		if (createdHere) await stopOwner(owner);
		throw error;
	}
}

/** Sends a session's brief exactly once — call it only after setup and pane registration succeed. */
export function startOpenCodePrompt(taskId: string, sessionId: string, prompt: string): Promise<void> {
	if (!prompt) return Promise.resolve();
	const owner = owners.get(ownerKey(taskId, sessionId));
	if (!owner) return Promise.reject(new Error("OpenCode prompt cannot start because its managed session owner is missing."));
	// Claimed before yielding: even a lost response must not let a second call resend the brief.
	owner.prompt ??= owner.ready.then(async (server) => {
		assertLive(owner);
		await requestJson(server, `/api/session/${encodeURIComponent(sessionId)}/prompt`, owner.controller.signal, {
			method: "POST",
			body: JSON.stringify({ id: `msg_${crypto.randomUUID().replaceAll("-", "")}`, text: prompt }),
		});
	});
	return owner.prompt;
}

/** A V2 launch script carries the server password: it is private and removed with its server. */
export async function writeOpenCodeLaunchScript(taskId: string, sessionId: string, scriptPath: string, body: string): Promise<void> {
	await writeLaunchScript(scriptPath, body, { private: true });
	for (const owner of owners.values()) owner.scripts.delete(scriptPath);
	owners.get(ownerKey(taskId, sessionId))?.scripts.add(scriptPath);
}

export async function stopOpenCodeServer(taskId: string, sessionId: string): Promise<void> {
	const owner = owners.get(ownerKey(taskId, sessionId));
	if (owner) await stopOwner(owner);
}

/** Cancels pending starts and verifies every server of the task is gone; launches stay refused until it succeeds. */
export async function stopOpenCodeServers(taskId: string): Promise<void> {
	stoppingTasks.add(taskId);
	await Promise.all([...owners.values()].filter((owner) => owner.taskId === taskId).map(stopOwner));
	stoppingTasks.delete(taskId);
}

export async function stopAllOpenCodeServers(): Promise<void> {
	shuttingDown = true;
	await Promise.all([...owners.values()].map(stopOwner));
}

export function resetOpenCodeServerStateForTests(): void {
	shuttingDown = false;
	stoppingTasks.clear();
	owners.clear();
}
