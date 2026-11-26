import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn(), terminatePidsVerified: vi.fn(async () => [] as number[]) }));
vi.mock("../spawn", () => ({ spawn: mocks.spawn }));
vi.mock("../process-reaper", () => ({
	isPidAlive: vi.fn(() => false),
	waitForPidsGone: vi.fn(async () => []),
	terminatePidsVerified: mocks.terminatePidsVerified,
}));

import { prepareOpenCodeLaunch, resetOpenCodeServerStateForTests, startOpenCodePrompt, stopAllOpenCodeServers, stopOpenCodeServer, stopOpenCodeServers, writeOpenCodeLaunchScript } from "../opencode-server";

function response(status: number, data: unknown = {}): Response {
	return { ok: status >= 200 && status < 300, status, json: async () => data } as Response;
}

/** A request that never answers, rejecting only when aborted — as real fetch does. */
function stalled(signal: AbortSignal): Promise<Response> {
	return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
}

describe("OpenCode V2 managed server", () => {
	let requests: Array<{ path: string; method: string; body?: Record<string, unknown>; authorization?: string }>;
	let originalServe: unknown;
	let nextPort: number;
	let serveCalls: number;

	beforeEach(() => {
		requests = [];
		nextPort = 49152;
		serveCalls = 0;
		originalServe = (globalThis as any).Bun.serve;
		(globalThis as any).Bun.serve = () => { serveCalls++; return { port: nextPort++, stop: async () => {} }; };
		mocks.kill.mockReset();
		mocks.terminatePidsVerified.mockReset().mockResolvedValue([]);
		mocks.spawn.mockReset().mockImplementation((_argv: string[], options: { env: Record<string, string> }) => ({
			pid: 1234,
			exited: new Promise<number>(() => {}),
			kill: mocks.kill,
			options,
		}));
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
			const url = new URL(String(input));
			const entry = {
				path: url.pathname,
				method: init.method ?? "GET",
				body: typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined,
				authorization: new Headers(init.headers).get("Authorization") ?? undefined,
			};
			requests.push(entry);
			if (entry.path === "/api/info") return response(200);
			if (entry.path === "/api/session" && entry.method === "POST") return response(200, { data: { id: "ses_api-created" } });
			if (entry.path === "/api/session/ses_api-created") return response(200, { data: { id: "ses_api-created" } });
			if (entry.path === "/api/session/ses_api-created/prompt") return response(200, { data: {} });
			if (entry.path === "/api/session/ses_saved") return response(200, { data: { id: "ses_saved" } });
			if (entry.path.startsWith("/api/session/ses_panel-")) {
				return response(200, { data: { id: entry.path.slice("/api/session/".length) } });
			}
			if (entry.path === "/api/session/ses_missing") return response(404);
			return response(500);
		}));
	});

	afterEach(async () => {
		await stopAllOpenCodeServers();
		resetOpenCodeServerStateForTests();
		(globalThis as any).Bun.serve = originalServe;
		vi.unstubAllGlobals();
	});

	it("creates the selected session without running its prompt before the launch gate", async () => {
		const prompt = "First line\nSecond 'line' with $HOME";
		const result = await prepareOpenCodeLaunch({
			taskId: "task-a",
			baseCommand: "env /opt/opencode/bin/opencode",
			cwd: "/worktree",
			env: { PROVIDER_TOKEN: "test-token" },
			spec: {
				agent: "sisyphus",
				model: { providerID: "anthropic", id: "claude-opus-4-6", variant: "high" },
				prompt,
				additionalArgs: [],
			},
		});

		expect(result.sessionId).toBe("ses_api-created");
		expect(result.command).toMatch(/^\/opt\/opencode\/bin\/opencode --server 'http:\/\/127\.0\.0\.1:\d+' --session 'ses_api-created'$/);
		expect(mocks.spawn).toHaveBeenCalledWith(
			["/opt/opencode/bin/opencode", "serve", "--hostname", "127.0.0.1", "--port", expect.any(String)],
			expect.objectContaining({
				detached: process.platform !== "win32",
				env: expect.objectContaining({ PROVIDER_TOKEN: "test-token", OPENCODE_PASSWORD: expect.any(String) }),
			}),
		);
		expect(requests.find((request) => request.path === "/api/session" && request.method === "POST")?.body).toEqual({
			location: { directory: "/worktree" },
			agent: "sisyphus",
			model: { providerID: "anthropic", id: "claude-opus-4-6", variant: "high" },
		});
		expect(requests.some((request) => request.path.endsWith("/prompt"))).toBe(false);
		expect(result.passwordEnv).toEqual({ OPENCODE_PASSWORD: expect.any(String), OPENCODE_SERVER_PASSWORD: result.passwordEnv.OPENCODE_PASSWORD });
		await startOpenCodePrompt("task-a", result.sessionId, prompt);
		const promptRequests = requests.filter((request) => request.path === "/api/session/ses_api-created/prompt");
		expect(promptRequests).toHaveLength(1);
		expect(promptRequests[0]?.body).toMatchObject({ text: prompt, id: expect.stringMatching(/^msg_/) });
		expect(promptRequests[0]?.authorization).toMatch(/^Basic /);
		await startOpenCodePrompt("task-a", result.sessionId, prompt);
		expect(requests.filter((request) => request.path.endsWith("/prompt"))).toHaveLength(1);
	});

	it("shares one atomic prompt submission between concurrent callers", async () => {
		const prepared = await prepareOpenCodeLaunch({
			taskId: "task-prompt-race",
			baseCommand: "opencode",
			cwd: "/worktree",
			env: {},
			spec: { prompt: "one brief", additionalArgs: [] },
		});

		const first = startOpenCodePrompt("task-prompt-race", prepared.sessionId, "one brief");
		const second = startOpenCodePrompt("task-prompt-race", prepared.sessionId, "one brief");
		expect(second).toBe(first);
		await Promise.all([first, second]);
		expect(requests.filter((request) => request.path.endsWith("/prompt"))).toHaveLength(1);
	});

	it("opens only the stored session on resume and refuses a missing one", async () => {
		const resume = await prepareOpenCodeLaunch({
			taskId: "task-b",
			baseCommand: "opencode",
			cwd: "/worktree",
			env: {},
			spec: { sessionId: "ses_saved", additionalArgs: [] },
		});
		expect(resume.command).toMatch(/--session 'ses_saved'$/);
		expect(requests.some((request) => request.method === "POST" && request.path === "/api/session")).toBe(false);
		expect(requests.some((request) => request.path.endsWith("/prompt"))).toBe(false);

		await expect(prepareOpenCodeLaunch({
			taskId: "task-c",
			baseCommand: "opencode",
			cwd: "/worktree",
			env: {},
			spec: { sessionId: "ses_missing", additionalArgs: [] },
		})).rejects.toThrow("no other session was selected");
		expect(mocks.terminatePidsVerified).toHaveBeenCalledTimes(1);
	});

	it("bounds an HTTP request even when the fetch implementation does not settle", async () => {
		const prepared = await prepareOpenCodeLaunch({
			taskId: "task-http-deadline",
			baseCommand: "opencode",
			cwd: "/worktree",
			env: {},
			spec: { sessionId: "ses_api-created", additionalArgs: [] },
		});
		let requestSignal: AbortSignal | undefined;
		vi.mocked(fetch).mockImplementation((input, init) => {
			if (new URL(String(input)).pathname.endsWith("/prompt")) {
				requestSignal = init?.signal as AbortSignal;
				return stalled(requestSignal);
			}
			return Promise.resolve(response(200, { data: {} }));
		});
		vi.useFakeTimers();
		try {
			const prompt = startOpenCodePrompt("task-http-deadline", prepared.sessionId, "bounded prompt");
			const rejected = expect(prompt).rejects.toThrow("exceeded its deadline");
			await vi.advanceTimersByTimeAsync(15_000);
			await rejected;
			expect(requestSignal?.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("aborts and bounds a stalled startup readiness probe", async () => {
		let probeSignal: AbortSignal | undefined;
		vi.mocked(fetch).mockImplementation((input, init) => {
			if (new URL(String(input)).pathname === "/api/info") {
				probeSignal = init?.signal as AbortSignal;
				return stalled(probeSignal);
			}
			return Promise.resolve(response(200, { data: { id: "ses_api-created" } }));
		});
		vi.useFakeTimers();
		try {
			const launch = prepareOpenCodeLaunch({
				taskId: "task-startup-deadline",
				baseCommand: "opencode",
				cwd: "/worktree",
				env: {},
				spec: { sessionId: "ses_api-created", additionalArgs: [] },
			});
			const rejected = expect(launch).rejects.toThrow("did not become ready within 12 seconds");
			await vi.advanceTimersByTimeAsync(13_000);
			await rejected;
			expect(probeSignal?.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("retains server ownership until verified termination succeeds", async () => {
		const prepared = await prepareOpenCodeLaunch({
			taskId: "task-stop-unverified",
			baseCommand: "opencode",
			cwd: "/worktree",
			env: {},
			spec: { sessionId: "ses_api-created", additionalArgs: [] },
		});
		mocks.terminatePidsVerified.mockResolvedValueOnce([-1234]).mockResolvedValueOnce([]);

		await expect(stopOpenCodeServer("task-stop-unverified", prepared.sessionId)).rejects.toThrow("ownership is retained");
		await expect(startOpenCodePrompt("task-stop-unverified", prepared.sessionId, "must not run on a stopping server"))
			.rejects.toThrow("owner is stopping");
		await expect(stopOpenCodeServer("task-stop-unverified", prepared.sessionId)).resolves.toBeUndefined();
		expect(requests.some((request) => request.path.endsWith("/prompt"))).toBe(false);
		expect(mocks.terminatePidsVerified).toHaveBeenNthCalledWith(1, [-1234], expect.any(Object));
		expect(mocks.terminatePidsVerified).toHaveBeenNthCalledWith(2, [-1234], expect.any(Object));
	});

	it("keeps a task launch gate closed while task-wide termination is unverified", async () => {
		await prepareOpenCodeLaunch({
			taskId: "task-stop-all-unverified",
			baseCommand: "opencode",
			cwd: "/worktree",
			env: {},
			spec: { sessionId: "ses_api-created", additionalArgs: [] },
		});
		mocks.terminatePidsVerified.mockResolvedValueOnce([-1234]).mockResolvedValueOnce([]);

		await expect(stopOpenCodeServers("task-stop-all-unverified")).rejects.toThrow("ownership is retained");
		await expect(prepareOpenCodeLaunch({
			taskId: "task-stop-all-unverified",
			baseCommand: "opencode",
			cwd: "/worktree",
			env: {},
			spec: { sessionId: "ses_api-created", additionalArgs: [] },
		})).rejects.toThrow("owner is stopping");
		await expect(stopOpenCodeServers("task-stop-all-unverified")).resolves.toBeUndefined();
	});

	it("validates the executable and reserved arguments before starting a server", async () => {
		for (const additionalArg of ["--standalone=true", "--dir=/other", "--continue=true"]) {
			await expect(prepareOpenCodeLaunch({
				taskId: `task-invalid-${additionalArg}`,
				baseCommand: "opencode",
				cwd: "/worktree",
				env: {},
				spec: { prompt: "must not be submitted", additionalArgs: [additionalArg] },
			})).rejects.toThrow("cannot override the managed server");
		}
		await expect(prepareOpenCodeLaunch({
			taskId: "task-invalid-binary",
			baseCommand: "opencode --bad",
			cwd: "/worktree",
			env: {},
			spec: { prompt: "must not be submitted", additionalArgs: [] },
		})).rejects.toThrow("without command-line arguments");
		expect(serveCalls).toBe(0);
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(requests.some((request) => request.path === "/api/session" && request.method === "POST")).toBe(false);
	});

	it("reuses a fresh session's managed server when that session is resumed", async () => {
		const fresh = await prepareOpenCodeLaunch({
			taskId: "task-fresh-resume",
			baseCommand: "opencode",
			cwd: "/worktree",
			env: {},
			spec: { prompt: "first turn", additionalArgs: [] },
		});
		const resumed = await prepareOpenCodeLaunch({
			taskId: "task-fresh-resume",
			baseCommand: "opencode",
			cwd: "/worktree",
			env: {},
			spec: { sessionId: fresh.sessionId, additionalArgs: [] },
		});
		expect(resumed.passwordEnv).toEqual(fresh.passwordEnv);
		expect(mocks.spawn).toHaveBeenCalledTimes(1);
	});

	it("cancels startup during port reservation and waits before task cleanup returns", async () => {
		let releaseReservation!: () => void;
		(globalThis as any).Bun.serve = () => ({
			port: 49152,
			stop: () => new Promise<void>((resolve) => { releaseReservation = resolve; }),
		});
		const launch = prepareOpenCodeLaunch({
			taskId: "task-cancel-reserve",
			baseCommand: "opencode",
			cwd: "/worktree",
			env: {},
			spec: { prompt: "not started", additionalArgs: [] },
		});
		let cleanupFinished = false;
		const cleanup = stopOpenCodeServers("task-cancel-reserve").then(() => { cleanupFinished = true; });
		expect(cleanupFinished).toBe(false);
		releaseReservation();
		await expect(launch).rejects.toThrow("cancelled");
		await cleanup;
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it("stops only the server for a closed pane while sibling pane servers continue", async () => {
		const firstPane = await prepareOpenCodeLaunch({
			taskId: "task-shared",
			baseCommand: "opencode",
			cwd: "/worktree",
			env: {},
			spec: { sessionId: "ses_panel-first", additionalArgs: [] },
		});
		const secondPane = await prepareOpenCodeLaunch({
			taskId: "task-shared",
			baseCommand: "opencode",
			cwd: "/worktree",
			env: {},
			spec: { sessionId: "ses_panel-second", additionalArgs: [] },
		});

		await stopOpenCodeServer("task-shared", firstPane.sessionId);

		expect(mocks.terminatePidsVerified).toHaveBeenCalledTimes(1);
		await expect(prepareOpenCodeLaunch({
			taskId: "task-shared",
			baseCommand: "opencode",
			cwd: "/worktree",
			env: {},
			spec: { sessionId: "ses_panel-second", additionalArgs: [] },
		})).resolves.toMatchObject({ sessionId: secondPane.sessionId });
		expect(mocks.spawn).toHaveBeenCalledTimes(2);
		expect(mocks.terminatePidsVerified).toHaveBeenCalledTimes(1);

		await stopOpenCodeServer("task-shared", secondPane.sessionId);
		expect(mocks.terminatePidsVerified).toHaveBeenCalledTimes(2);
	});

	it("writes credential scripts privately and removes them with their server owner", async () => {
		const root = mkdtempSync(join(tmpdir(), "opencode-script-owner-"));
		const path = join(root, "launch.sh");
		const prepared = await prepareOpenCodeLaunch({
			taskId: "task-private-script",
			baseCommand: "opencode",
			cwd: "/worktree",
			env: {},
			spec: { sessionId: "ses_saved", additionalArgs: [] },
		});
		try {
			const password = prepared.passwordEnv.OPENCODE_SERVER_PASSWORD;
			await writeOpenCodeLaunchScript("task-private-script", prepared.sessionId, path, `export OPENCODE_SERVER_PASSWORD=${password}\n`);
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(readFileSync(path, "utf8")).toContain(password);
			await stopOpenCodeServer("task-private-script", prepared.sessionId);
			expect(existsSync(path)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
