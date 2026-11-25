import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
const whichMock = vi.fn();

function fakeProc(stdout: string, stderr = "", exitCode = 0) {
	const encoder = new TextEncoder();
	return {
		exited: Promise.resolve(exitCode),
		stdout: new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(stdout));
				controller.close();
			},
		}),
		stderr: new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(stderr));
				controller.close();
			},
		}),
	};
}

vi.mock("../spawn", () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock("../which", () => ({
	which: (...args: unknown[]) => whichMock(...args),
}));

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

describe("github", () => {
	afterEach(() => vi.unstubAllGlobals());
	beforeEach(() => {
		vi.resetModules();
		spawnMock.mockReset();
		whichMock.mockReset();
	});

	it("returns not_installed when gh is missing", async () => {
		whichMock.mockResolvedValue(null);

		const { getGitHubCliStatus } = await import("../github");
		await expect(getGitHubCliStatus()).resolves.toEqual({
			authStatus: "not_installed",
			binaryPath: null,
			accounts: [],
		});
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("parses authenticated accounts from gh auth status json", async () => {
		whichMock.mockResolvedValue("/opt/homebrew/bin/gh");
		spawnMock.mockReturnValue(fakeProc(JSON.stringify({
			hosts: {
				"github.com": [
					{ login: "h0x91b", host: "github.com", active: true, state: "success" },
					{ login: "h0x91b-work", host: "github.com", active: false, state: "success" },
					{ login: "broken", host: "github.com", active: false, state: "failure" },
				],
			},
		})));

		const { getGitHubCliStatus } = await import("../github");
		await expect(getGitHubCliStatus()).resolves.toEqual({
			authStatus: "authenticated",
			binaryPath: "/opt/homebrew/bin/gh",
			accounts: [
				{ login: "h0x91b", host: "github.com", active: true },
				{ login: "h0x91b-work", host: "github.com", active: false },
			],
		});
	});

	it("returns token env for the configured project account", async () => {
		whichMock.mockResolvedValue("/opt/homebrew/bin/gh");
		spawnMock.mockImplementation((cmd: string[]) => {
			if (cmd.join(" ") === "gh auth status --json hosts") {
				return fakeProc(JSON.stringify({
					hosts: {
						"github.com": [
							{ login: "h0x91b", host: "github.com", active: true, state: "success" },
							{ login: "h0x91b-work", host: "github.com", active: false, state: "success" },
						],
					},
				}));
			}
			if (cmd.join(" ") === "gh auth token --hostname github.com --user h0x91b-work") {
				return fakeProc("secret-token\n");
			}
			throw new Error(`Unexpected command: ${cmd.join(" ")}`);
		});

		const { getGitHubAuthEnv } = await import("../github");
		await expect(getGitHubAuthEnv({
			githubAuthHost: "github.com",
			githubAuthLogin: "h0x91b-work",
		})).resolves.toEqual({
			GH_TOKEN: "secret-token",
			GITHUB_TOKEN: "secret-token",
		});
	});

	it("falls back to plain gh auth status when --json is unsupported, across gh's output variants", async () => {
		const cases: Array<{ name: string; gh: string; stdout: string; stderr: string; exitCode?: number; expected: unknown }> = [
			{
				// Old gh writes auth status output to stderr.
				name: "old gh, stderr",
				gh: "/usr/bin/gh",
				stdout: "",
				stderr: "github.com\n  ✓ Logged in to github.com as h0x91b (oauth_token)\n  ✓ Git operations for github.com configured to use https protocol.\n  ✓ Token: gho_******\n",
				expected: { authStatus: "authenticated", binaryPath: "/usr/bin/gh", accounts: [{ login: "h0x91b", host: "github.com", active: true }] },
			},
			{
				name: "plain output on stdout",
				gh: "/usr/bin/gh",
				stdout: "github.com\n  ✓ Logged in to github.com as h0x91b-work (keyring)\n  ✓ Logged in to github.com as h0x91b (oauth_token)\n",
				stderr: "",
				expected: { authStatus: "authenticated", binaryPath: "/usr/bin/gh", accounts: [
					{ login: "h0x91b-work", host: "github.com", active: true },
					{ login: "h0x91b", host: "github.com", active: false },
				] },
			},
			{
				// gh ~2.50+ (e.g. v2.63.2) wording: "Logged in to <host> account <login>".
				name: "modern 'account X' wording",
				gh: "/opt/homebrew/bin/gh",
				stdout: "github.com\n  ✓ Logged in to github.com account barvolovski (keyring)\n  - Active account: true\n  - Git operations protocol: https\n  - Token: gho_******\n  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'\n",
				stderr: "",
				expected: { authStatus: "authenticated", binaryPath: "/opt/homebrew/bin/gh", accounts: [{ login: "barvolovski", host: "github.com", active: true }] },
			},
			{
				name: "'Active account: true' wins over list order",
				gh: "/opt/homebrew/bin/gh",
				stdout: "github.com\n  ✓ Logged in to github.com account h0x91b-work (keyring)\n  - Active account: false\n\n  ✓ Logged in to github.com account h0x91b (keyring)\n  - Active account: true\n",
				stderr: "",
				expected: { authStatus: "authenticated", binaryPath: "/opt/homebrew/bin/gh", accounts: [
					{ login: "h0x91b", host: "github.com", active: true },
					{ login: "h0x91b-work", host: "github.com", active: false },
				] },
			},
			{
				name: "fallback also fails",
				gh: "/usr/bin/gh",
				stdout: "",
				stderr: "You are not logged into any GitHub hosts.\n",
				exitCode: 1,
				expected: { authStatus: "not_authenticated", binaryPath: "/usr/bin/gh", accounts: [] },
			},
		];
		for (const c of cases) {
			vi.resetModules();
			whichMock.mockResolvedValue(c.gh);
			spawnMock.mockImplementation((cmd: string[]) => {
				if (cmd.join(" ") === "gh auth status --json hosts") return fakeProc("", "unknown flag: --json\n", 1);
				if (cmd.join(" ") === "gh auth status") return fakeProc(c.stdout, c.stderr, c.exitCode ?? 0);
				throw new Error(`Unexpected command: ${cmd.join(" ")}`);
			});
			const { getGitHubCliStatus } = await import("../github");
			expect(await getGitHubCliStatus(), c.name).toEqual(c.expected);
		}
	});

	it("caches authenticated status — repeated calls spawn gh only once", async () => {
		whichMock.mockResolvedValue("/opt/homebrew/bin/gh");
		spawnMock.mockImplementation(() => fakeProc(JSON.stringify({
			hosts: {
				"github.com": [
					{ login: "h0x91b", host: "github.com", active: true, state: "success" },
				],
			},
		})));

		const { getGitHubCliStatus } = await import("../github");
		await getGitHubCliStatus();
		await getGitHubCliStatus();
		await getGitHubCliStatus();
		expect(spawnMock).toHaveBeenCalledTimes(1);
	});

	it("does not cache not_authenticated status", async () => {
		whichMock.mockResolvedValue("/usr/bin/gh");
		spawnMock.mockImplementation((cmd: string[]) => {
			if (cmd.join(" ") === "gh auth status --json hosts") {
				return fakeProc("", "unknown flag: --json\n", 1);
			}
			return fakeProc("", "You are not logged into any GitHub hosts.\n", 1);
		});

		const { getGitHubCliStatus } = await import("../github");
		expect((await getGitHubCliStatus()).authStatus).toBe("not_authenticated");
		const callsAfterFirst = spawnMock.mock.calls.length;

		expect((await getGitHubCliStatus()).authStatus).toBe("not_authenticated");
		// Second call re-checks (not served from cache)
		expect(spawnMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
	});

	it("caches the resolved token — repeated getGitHubAuthEnv spawns auth token once", async () => {
		whichMock.mockResolvedValue("/opt/homebrew/bin/gh");
		const tokenCalls: string[] = [];
		spawnMock.mockImplementation((cmd: string[]) => {
			if (cmd.join(" ") === "gh auth status --json hosts") {
				return fakeProc(JSON.stringify({
					hosts: {
						"github.com": [
							{ login: "h0x91b", host: "github.com", active: true, state: "success" },
						],
					},
				}));
			}
			if (cmd[1] === "auth" && cmd[2] === "token") {
				tokenCalls.push(cmd.join(" "));
				return fakeProc("secret-token\n");
			}
			throw new Error(`Unexpected command: ${cmd.join(" ")}`);
		});

		const { getGitHubAuthEnv } = await import("../github");
		const selection = { githubAuthHost: null, githubAuthLogin: null };
		await getGitHubAuthEnv(selection);
		await getGitHubAuthEnv(selection);
		expect(tokenCalls).toHaveLength(1);
	});

	it("expires the auth status cache after the TTL", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			whichMock.mockResolvedValue("/opt/homebrew/bin/gh");
			spawnMock.mockImplementation(() => fakeProc(JSON.stringify({
				hosts: {
					"github.com": [
						{ login: "h0x91b", host: "github.com", active: true, state: "success" },
					],
				},
			})));

			const { getGitHubCliStatus } = await import("../github");
			await getGitHubCliStatus();
			expect(spawnMock).toHaveBeenCalledTimes(1);

			vi.setSystemTime(Date.now() + 2 * 60_000);
			await getGitHubCliStatus();
			expect(spawnMock).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("builds shell exports for the resolved account", async () => {
		whichMock.mockResolvedValue("/opt/homebrew/bin/gh");
		spawnMock.mockReturnValue(fakeProc(JSON.stringify({
			hosts: {
				"github.com": [
					{ login: "h0x91b", host: "github.com", active: true, state: "success" },
				],
			},
		})));

		const { getGitHubShellExports } = await import("../github");
		const lines = await getGitHubShellExports({
			githubAuthHost: null,
			githubAuthLogin: null,
		});

		expect(lines.join("\n")).toContain("gh auth token --hostname 'github.com' --user 'h0x91b'");
		expect(lines).toContain('export GH_TOKEN="$__DEV3_GH_TOKEN"');
		expect(lines).toContain('export GITHUB_TOKEN="$__DEV3_GH_TOKEN"');
	});

	it("reads the token from the environment for a GH_TOKEN-backed account (no gh auth token spawn)", async () => {
		whichMock.mockResolvedValue("/opt/homebrew/bin/gh");
		const spawnedTokenCmds: string[] = [];
		spawnMock.mockImplementation((cmd: string[]) => {
			if (cmd.join(" ") === "gh auth status --json hosts") {
				return fakeProc(JSON.stringify({
					hosts: {
						"github.com": [
							{ login: "h0x91b-work", host: "github.com", active: true, state: "success", tokenSource: "GH_TOKEN" },
						],
					},
				}));
			}
			if (cmd[1] === "auth" && cmd[2] === "token") {
				spawnedTokenCmds.push(cmd.join(" "));
				return fakeProc("stored-token\n");
			}
			throw new Error(`Unexpected command: ${cmd.join(" ")}`);
		});

		const original = process.env.GH_TOKEN;
		process.env.GH_TOKEN = "env-injected-token";
		try {
			const { getGitHubAuthEnv } = await import("../github");
			await expect(getGitHubAuthEnv({ githubAuthHost: "github.com", githubAuthLogin: "h0x91b-work" }))
				.resolves.toEqual({ GH_TOKEN: "env-injected-token", GITHUB_TOKEN: "env-injected-token" });
			// Env-backed accounts must never invoke `gh auth token --user`.
			expect(spawnedTokenCmds).toEqual([]);
		} finally {
			if (original === undefined) delete process.env.GH_TOKEN;
			else process.env.GH_TOKEN = original;
		}
	});

	it("throws a clear error when a GH_TOKEN-backed account's variable is empty", async () => {
		whichMock.mockResolvedValue("/opt/homebrew/bin/gh");
		spawnMock.mockImplementation((cmd: string[]) => {
			if (cmd.join(" ") === "gh auth status --json hosts") {
				return fakeProc(JSON.stringify({
					hosts: {
						"github.com": [
							{ login: "h0x91b-work", host: "github.com", active: true, state: "success", tokenSource: "GH_TOKEN" },
						],
					},
				}));
			}
			throw new Error(`Unexpected command: ${cmd.join(" ")}`);
		});

		const original = process.env.GH_TOKEN;
		delete process.env.GH_TOKEN;
		try {
			const { getGitHubAuthEnv } = await import("../github");
			await expect(getGitHubAuthEnv({ githubAuthHost: "github.com", githubAuthLogin: "h0x91b-work" }))
				.rejects.toThrow(/authenticated via GH_TOKEN/);
		} finally {
			if (original !== undefined) process.env.GH_TOKEN = original;
		}
	});

	it("neutralizes ambient token env vars when resolving a stored account's token", async () => {
		whichMock.mockResolvedValue("/opt/homebrew/bin/gh");
		let tokenEnv: Record<string, string> | undefined;
		spawnMock.mockImplementation((cmd: string[], opts?: { env?: Record<string, string> }) => {
			if (cmd.join(" ") === "gh auth status --json hosts") {
				return fakeProc(JSON.stringify({
					hosts: {
						"github.com": [
							{ login: "h0x91b", host: "github.com", active: true, state: "success", tokenSource: "keyring" },
						],
					},
				}));
			}
			if (cmd[1] === "auth" && cmd[2] === "token") {
				tokenEnv = opts?.env;
				return fakeProc("stored-token\n");
			}
			throw new Error(`Unexpected command: ${cmd.join(" ")}`);
		});

		const { getGitHubAuthEnv } = await import("../github");
		await getGitHubAuthEnv({ githubAuthHost: "github.com", githubAuthLogin: "h0x91b" });
		expect(tokenEnv).toMatchObject({ GH_TOKEN: "", GITHUB_TOKEN: "", GH_ENTERPRISE_TOKEN: "", GITHUB_ENTERPRISE_TOKEN: "" });
	});

	it("builds shell exports from the ambient env var for a GH_TOKEN-backed account", async () => {
		whichMock.mockResolvedValue("/opt/homebrew/bin/gh");
		spawnMock.mockReturnValue(fakeProc(JSON.stringify({
			hosts: {
				"github.com": [
					{ login: "h0x91b-work", host: "github.com", active: true, state: "success", tokenSource: "GH_TOKEN" },
				],
			},
		})));

		const { getGitHubShellExports } = await import("../github");
		const lines = await getGitHubShellExports({ githubAuthHost: null, githubAuthLogin: null });
		const script = lines.join("\n");
		expect(script).toContain('__DEV3_GH_TOKEN="$GH_TOKEN"');
		expect(script).not.toContain("gh auth token");
		expect(lines).toContain('export GH_TOKEN="$__DEV3_GH_TOKEN"');
	});

	it("drains stdout before awaiting exit (no pipe-buffer deadlock)", async () => {
		whichMock.mockResolvedValue("/opt/homebrew/bin/gh");
		const encoder = new TextEncoder();
		// A proc that only exits once its stdout has actually been read — mirrors a
		// child blocked on a full pipe buffer until the reader drains it. If runGh
		// awaited exit before reading, this would hang forever.
		function coupledProc(stdout: string) {
			let resolveExited!: (code: number) => void;
			const exited = new Promise<number>((r) => { resolveExited = r; });
			const stdoutStream = new ReadableStream({
				pull(controller) {
					controller.enqueue(encoder.encode(stdout));
					controller.close();
					resolveExited(0);
				},
			});
			return { exited, stdout: stdoutStream, stderr: new ReadableStream({ start(c) { c.close(); } }) };
		}
		spawnMock.mockImplementation((cmd: string[]) => {
			if (cmd.join(" ") === "gh auth status --json hosts") {
				return fakeProc(JSON.stringify({
					hosts: { "github.com": [{ login: "h0x91b", host: "github.com", active: true, state: "success" }] },
				}));
			}
			if (cmd[1] === "auth" && cmd[2] === "token") {
				return fakeProc("secret-token\n");
			}
			return coupledProc('[{"number":7,"url":"https://x/7"}]');
		});

		const { runGitHub } = await import("../github");
		const result = await runGitHub(
			{ githubAuthHost: "github.com", githubAuthLogin: "h0x91b" },
			"/tmp/wt",
			["pr", "list"],
		);
		expect(result.ok).toBe(true);
		expect(result.stdout).toContain('"number":7');
	});

	it("kills a gh command that exceeds its timeout and reports failure", async () => {
		vi.useFakeTimers();
		try {
			whichMock.mockResolvedValue("/opt/homebrew/bin/gh");
			const kill = vi.fn();
			const closedStream = () => new ReadableStream({ start(c) { c.close(); } });
			spawnMock.mockImplementation((cmd: string[]) => {
				if (cmd.join(" ") === "gh auth status --json hosts") {
					return fakeProc(JSON.stringify({
						hosts: { "github.com": [{ login: "h0x91b", host: "github.com", active: true, state: "success" }] },
					}));
				}
				if (cmd[1] === "auth" && cmd[2] === "token") {
					return fakeProc("secret-token\n");
				}
				// The actual command hangs forever — exited never resolves.
				return { exited: new Promise(() => {}), stdout: closedStream(), stderr: closedStream(), kill };
			});

			const { runGitHub } = await import("../github");
			const resultPromise = runGitHub(
				{ githubAuthHost: "github.com", githubAuthLogin: "h0x91b" },
				"/tmp/wt",
				["pr", "list"],
				{ timeoutMs: 5_000 },
			);
			await vi.advanceTimersByTimeAsync(5_000);
			const result = await resultPromise;

			expect(result.ok).toBe(false);
			expect(result.stderr).toMatch(/timed out/i);
			expect(kill).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	describe("GraphQL transport", () => {
		const account = { host: "github.com", login: "reader", active: true };
		beforeEach(() => spawnMock.mockImplementation(() => fakeProc("reader-token")));

		it("uses the API endpoint for github.com, GHE.com and GHE Server hosts", async () => {
			for (const [host, endpoint] of [["github.com", "https://api.github.com/graphql"], ["team.ghe.com", "https://api.team.ghe.com/graphql"], ["git.example.com", "https://git.example.com/api/graphql"]]) {
				vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: { ok: true } })));
				const { queryGitHub } = await import("../github");
				expect(await queryGitHub({ ...account, host }, "query { viewer { login } }", {}, AbortSignal.timeout(1000)), host).toEqual({ ok: true });
				expect(fetch, host).toHaveBeenCalledWith(endpoint, expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer reader-token" }), redirect: "error" }));
			}
		});

		it("does not rate-limit unrelated repositories after a permission-only 403", async () => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("", { status: 403 })).mockResolvedValue(Response.json({ data: { ok: true } })));
			const { queryGitHub } = await import("../github");
			await expect(queryGitHub(account, "q", { name: "restricted" }, AbortSignal.timeout(1000))).rejects.toThrow("HTTP 403");
			await expect(queryGitHub(account, "q", { name: "accessible" }, AbortSignal.timeout(1000))).resolves.toEqual({ ok: true });
			expect(fetch).toHaveBeenCalledTimes(2);
		});

		it("backs off on a secondary rate-limit message with HTTP 200 or 403 and no retry header", async () => {
			for (const status of [200, 403]) {
				vi.resetModules();
				const body = status === 200 ? { errors: [{ message: "You have exceeded a secondary rate limit." }] } : { message: "You have exceeded a secondary rate limit." };
				vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body, { status })));
				const { queryGitHub } = await import("../github");
				await expect(queryGitHub(account, "q", {}, AbortSignal.timeout(1000)), `HTTP ${status}`).rejects.toThrow();
				await expect(queryGitHub(account, "q", {}, AbortSignal.timeout(1000)), `HTTP ${status}`).rejects.toThrow("rate limit");
				expect(fetch, `HTTP ${status}`).toHaveBeenCalledTimes(1);
			}
		});

		it("rejects GraphQL errors on HTTP 200, preserving error paths and partial data for the PR reader", async () => {
			const data = { repository: { open: { nodes: [{ number: 42 }] }, known: null } };
			const errors = [{ type: "NOT_FOUND", path: ["repository", "known"], message: "No such PR" }];
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data, errors })));
			const { queryGitHub } = await import("../github");
			await expect(queryGitHub(account, "q", {}, AbortSignal.timeout(1000))).rejects.toMatchObject({ message: expect.stringContaining("No such PR"), data, errors });
		});

		it("honors Retry-After and does not issue more requests while rate limited", async () => {
			vi.useFakeTimers(); vi.setSystemTime(0);
			try {
				vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "120" } })).mockResolvedValue(Response.json({ data: { ok: true } })));
				const { queryGitHub } = await import("../github");
				await expect(queryGitHub(account, "q", {}, new AbortController().signal)).rejects.toThrow("HTTP 429");
				vi.setSystemTime(119_999);
				await expect(queryGitHub(account, "q", {}, new AbortController().signal)).rejects.toThrow("rate limit");
				expect(fetch).toHaveBeenCalledTimes(1);
				vi.setSystemTime(120_000);
				await expect(queryGitHub(account, "q", {}, new AbortController().signal)).resolves.toEqual({ ok: true });
			} finally { vi.useRealTimers(); }
		});

		it("keeps the longer primary-limit reset when GraphQL also reports RATE_LIMITED", async () => {
			vi.useFakeTimers(); vi.setSystemTime(0);
			try {
				vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ errors: [{ type: "RATE_LIMITED", message: "limited" }] }, { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "600" } })));
				const { queryGitHub } = await import("../github");
				await expect(queryGitHub(account, "q", {}, new AbortController().signal)).rejects.toThrow("limited");
				vi.setSystemTime(120_000);
				await expect(queryGitHub(account, "q", {}, new AbortController().signal)).rejects.toThrow("rate limit");
				expect(fetch).toHaveBeenCalledTimes(1);
			} finally { vi.useRealTimers(); }
		});

		it("invalidates a rejected token so the next request can use updated gh credentials", async () => {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("", { status: 401 })).mockResolvedValue(Response.json({ data: { ok: true } })));
			const { queryGitHub } = await import("../github");
			await expect(queryGitHub(account, "q", {}, AbortSignal.timeout(1000))).rejects.toThrow("HTTP 401");
			await queryGitHub(account, "q", {}, AbortSignal.timeout(1000));
			expect(spawnMock).toHaveBeenCalledTimes(2);
		});

		it("passes cancellation to fetch and exposes a timeout as unavailable", async () => {
			vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
				options.signal.throwIfAborted();
				throw new Error("not reached");
			}));
			const { queryGitHub } = await import("../github");
			const controller = new AbortController(); controller.abort(new Error("request timed out"));
			await expect(queryGitHub(account, "q", {}, controller.signal)).rejects.toThrow("timed out");
		});
	});

	describe("isPullRequestMerged", () => {
		const PROJECT = { githubAuthHost: "github.com", githubAuthLogin: "h0x91b" };

		function mockGhPrView(state: string | null, ok = true, headRefName = "feat/mine") {
			whichMock.mockResolvedValue("/opt/homebrew/bin/gh");
			spawnMock.mockImplementation((cmd: string[]) => {
				if (cmd[1] === "auth" && cmd[2] === "status") return fakeProc(JSON.stringify({
					hosts: { "github.com": [{ login: "h0x91b", host: "github.com", active: true, state: "success" }] },
				}));
				if (cmd[1] === "auth" && cmd[2] === "token") return fakeProc("secret-token");
				return fakeProc(JSON.stringify({ nameWithOwner: "h0x91b/dev-3.0", url: "https://github.com/h0x91b/dev-3.0" }));
			});
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(ok ? { data: { repository: { known: {
				number: 1077, url: "https://github.com/h0x91b/dev-3.0/pull/1077", state, headRefName, commits: { nodes: [] },
				reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
			} } } } : { errors: [{ message: "no such PR" }] })));
		}

		it("answers merged only for a merged PR owned by this branch (or any merged PR when no branch is known)", async () => {
			const cases: Array<[name: string, state: string | null, ok: boolean, head: string, pr: number, branch: string | null, expected: boolean]> = [
				["merged PR on this branch", "MERGED", true, "feat/mine", 1077, "feat/mine", true],
				["open PR", "OPEN", true, "feat/mine", 1077, "feat/mine", false],
				["gh fails (offline / unauthenticated)", null, false, "feat/mine", 1077, "feat/mine", false],
				["merged PR of another branch", "MERGED", true, "contributor/their-feature", 1255, "fix/mine", false],
				["no branch known: no ownership check", "MERGED", true, "contributor/their-feature", 1255, null, true],
			];
			for (const [name, state, ok, head, pr, branch, expected] of cases) {
				vi.resetModules();
				mockGhPrView(state, ok, head);
				const { isPullRequestMerged } = await import("../github");
				expect(await isPullRequestMerged(PROJECT, "/tmp/wt", pr, branch), name).toBe(expected);
			}
		});

		it("reports state and head branch via getPullRequestSnapshot", async () => {
			mockGhPrView("MERGED", true, "contributor/their-feature");
			const { getPullRequestSnapshot } = await import("../github");
			await expect(getPullRequestSnapshot(PROJECT, "/tmp/wt", 1255)).resolves.toEqual({
				state: "MERGED",
				headRefName: "contributor/their-feature",
			});
		});

		it("shares a recent merged answer instead of re-querying GitHub", async () => {
			mockGhPrView("MERGED");
			const { isPullRequestMerged } = await import("../github");
			await isPullRequestMerged(PROJECT, "/tmp/wt", 1077, "feat/mine");
			const callsAfterFirst = spawnMock.mock.calls.length;
			await isPullRequestMerged(PROJECT, "/tmp/wt", 1077, "feat/mine");
			expect(spawnMock.mock.calls.length).toBe(callsAfterFirst);
		});

		it("keeps merged ownership proof after the rich status expires and GitHub goes offline", async () => {
			vi.useFakeTimers(); vi.setSystemTime(0);
			try {
				mockGhPrView("MERGED");
				const { isPullRequestMerged, readTaskPullRequest } = await import("../github");
				await expect(isPullRequestMerged(PROJECT, "/tmp/wt", 1077, "feat/mine")).resolves.toBe(true);
				vi.setSystemTime(60_001);
				vi.mocked(fetch).mockRejectedValue(new Error("offline"));
				expect(await readTaskPullRequest(PROJECT, "/tmp/wt", "", 1077)).toBeNull();
				await expect(isPullRequestMerged(PROJECT, "/tmp/wt", 1077, "feat/mine")).resolves.toBe(true);
				await expect(isPullRequestMerged(PROJECT, "/tmp/wt", 1077, "other/branch")).resolves.toBe(false);
			} finally { vi.useRealTimers(); }
		});
	});

	/**
	 * These two strings are gh's own, copied from a live run. The check exists
	 * because the OBVIOUS implementation — match github.com in the remote URL —
	 * is wrong in the field: an SSH config alias hides the host, so
	 * `git@github.com-personal:owner/repo` (the two-accounts setup this repo
	 * itself uses) reads as "not GitHub" while gh resolves it fine.
	 */
	describe("isNotAGitHubRepoError", () => {
		const PROJECT = { githubAuthHost: "github.com", githubAuthLogin: "h0x91b" };

		it("recognises only gh's refusal on a non-GitHub remote, never any other failure", async () => {
			const { isNotAGitHubRepoError } = await import("../github");
			expect(isNotAGitHubRepoError({
				stderr: "none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`",
			})).toBe(true);
			expect(isNotAGitHubRepoError({ stdout: "no git remotes found" })).toBe(true);
			// Every one of these must leave the PR button alone: killing a working
			// button is worse than one wasted agent turn.
			for (const stderr of [
				"",
				"error connecting to api.github.com",
				"gh: command timed out",
				"gh auth login required",
				"HTTP 502: Bad gateway",
				"could not resolve host",
			]) {
				expect(isNotAGitHubRepoError({ stderr }), stderr).toBe(false);
			}
		});

		/** `gh repo view` answering whatever the case under test needs, past the auth handshake. */
		function mockGhRepoView(stdout: string, stderr = "", exitCode = 0) {
			whichMock.mockResolvedValue("/opt/homebrew/bin/gh");
			spawnMock.mockImplementation((cmd: string[]) => {
				if (cmd.join(" ") === "gh auth status --json hosts") {
					return fakeProc(JSON.stringify({
						hosts: { "github.com": [{ login: "h0x91b", host: "github.com", active: true, state: "success" }] },
					}));
				}
				if (cmd[1] === "auth" && cmd[2] === "token") return fakeProc("secret-token\n");
				return fakeProc(stdout, stderr, exitCode);
			});
		}

		/** A blip must not disable the button — the whole point of the polarity. */
		it("reports not-GitHub only when gh says the remotes are not GitHub", async () => {
			const cases: Array<[name: string, stdout: string, stderr: string, exitCode: number, expected: boolean]> = [
				["gh succeeds", '{"nameWithOwner":"h0x91b/dev-3.0"}', "", 0, true],
				["remotes are not GitHub", "", "none of the git remotes configured for this repository point to a known GitHub host.", 1, false],
				["any other gh failure", "", "HTTP 502: Bad gateway", 1, true],
			];
			for (const [name, stdout, stderr, exitCode, expected] of cases) {
				vi.resetModules();
				mockGhRepoView(stdout, stderr, exitCode);
				const { isGitHubRepo } = await import("../github");
				expect(await isGitHubRepo(PROJECT, "/tmp/wt"), name).toBe(expected);
			}
		});

		describe("findOpenPullRequest", () => {
			it("uses GraphQL after gh resolves an SSH-alias repository", async () => {
				mockGhRepoView(JSON.stringify({ nameWithOwner: "h0x91b/dev-3.0", url: "https://github.com/h0x91b/dev-3.0" }));
				vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: { repository: { open: { nodes: [{
					number: 1475, url: "https://github.com/h0x91b/dev-3.0/pull/1475", title: "Pin tmux", state: "OPEN", headRefName: "dev3/t",
					author: { login: "h0x91b", name: "Arseny" }, commits: { nodes: [] },
					reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
				}] } } } })));
				const { findOpenPullRequest } = await import("../github");
				await expect(findOpenPullRequest(PROJECT, "/tmp/wt", "dev3/t")).resolves.toEqual({
					pr: { number: 1475, url: "https://github.com/h0x91b/dev-3.0/pull/1475", title: "Pin tmux", author: "Arseny" }, isGitHub: true, status: expect.objectContaining({ state: "OPEN", unresolvedCount: 0, checkedAt: expect.any(Number) }),
				});
				expect(spawnMock.mock.calls.some(([cmd]) => cmd[1] === "pr")).toBe(false);
				expect(fetch).toHaveBeenCalledWith("https://api.github.com/graphql", expect.objectContaining({
					headers: expect.objectContaining({ Authorization: "Bearer secret-token" }), redirect: "error",
				}));
			});
			it("preserves the non-GitHub verdict and skips empty branches", async () => {
				mockGhRepoView("", "none of the git remotes configured for this repository point to a known GitHub host.", 1);
				const { findOpenPullRequest } = await import("../github");
				await expect(findOpenPullRequest(PROJECT, "/tmp/wt", "b")).resolves.toEqual({ pr: null, isGitHub: false });
				spawnMock.mockClear();
				await expect(findOpenPullRequest(PROJECT, "/tmp/wt", "")).resolves.toEqual({ pr: null, isGitHub: true });
				expect(spawnMock).not.toHaveBeenCalled();
			});
		});

		describe("findPullRequestForHead", () => {
			const fork = (number: number, owner: string, state = "OPEN") => ({
				number, url: `https://github.com/h0x91b/dev-3.0/pull/${number}`, state,
				isCrossRepository: true, headRepositoryOwner: { login: owner },
			});
			const own = (number: number, state = "OPEN") => ({
				number, url: `https://github.com/h0x91b/dev-3.0/pull/${number}`, state,
				isCrossRepository: false, headRepositoryOwner: { login: "h0x91b" },
			});

			// `--head` matches the branch NAME, so a namesake on another fork must
			// never stand in for the PR the review ref actually came from.
			it("picks the PR from the fork the ref came from", async () => {
				mockGhRepoView(JSON.stringify([fork(2070, "someone-else"), fork(2067, "MCaldas"), own(1990)]));
				const { findPullRequestForHead } = await import("../github");
				await expect(findPullRequestForHead(PROJECT, "/tmp/wt", "fix/x", { forkOwner: "mcaldas" }))
					.resolves.toMatchObject({ number: 2067, url: "https://github.com/h0x91b/dev-3.0/pull/2067" });
				const args = spawnMock.mock.calls.map(([cmd]) => (cmd as string[]).join(" ")).find((c) => c.includes("pr list"));
				expect(args).toContain("--state all");
			});

			it("picks a same-repo PR for an origin ref (open before an older closed one), or a merged PR when nothing open shares its head", async () => {
				const cases = [
					{ name: "origin ref", prs: [fork(2071, "mcaldas"), own(1500, "CLOSED"), own(2068)], forkOwner: null, expected: 2068 },
					{ name: "merged only", prs: [fork(2067, "mcaldas", "MERGED")], forkOwner: "mcaldas", expected: 2067 },
				];
				const { findPullRequestForHead } = await import("../github");
				for (const c of cases) {
					mockGhRepoView(JSON.stringify(c.prs));
					expect(await findPullRequestForHead(PROJECT, "/tmp/wt", "fix/x", { forkOwner: c.forkOwner }), c.name).toMatchObject({ number: c.expected });
				}
			});

			it("answers null for no match, a gh failure, unparsable output and no branch", async () => {
				const { findPullRequestForHead } = await import("../github");
				for (const [stdout, stderr, code] of [[JSON.stringify([fork(1, "other")]), "", 0], ["", "gh: not found", 1], ["not json", "", 0]] as const) {
					mockGhRepoView(stdout, stderr, code);
					await expect(findPullRequestForHead(PROJECT, "/tmp/wt", "fix/x", { forkOwner: "mcaldas" })).resolves.toBeNull();
				}
				spawnMock.mockClear();
				await expect(findPullRequestForHead(PROJECT, "/tmp/wt", "", { forkOwner: null })).resolves.toBeNull();
				expect(spawnMock).not.toHaveBeenCalled();
			});
		});

		describe("merge method", () => {
			// `gh pr merge` with no method flag PROMPTS when several are allowed, which in
			// a headless call is a hang — so a method is always chosen here.
			it("prefers squash, then a merge commit, then rebase", async () => {
				const { pickMergeMethod } = await import("../github");
				expect(pickMergeMethod({ squash: true, merge: true, rebase: true })).toBe("squash");
				expect(pickMergeMethod({ merge: true, rebase: true })).toBe("merge");
				expect(pickMergeMethod({ rebase: true })).toBe("rebase");
				// Nothing allowed is not a real GitHub answer — it means the read failed.
				expect(pickMergeMethod({})).toBe("squash");
			});

			it("reads the repo's allowed methods, and falls back when it cannot", async () => {
				mockGhRepoView(JSON.stringify({ squashMergeAllowed: false, mergeCommitAllowed: true, rebaseMergeAllowed: true }));
				const { resolveMergeMethod } = await import("../github");
				await expect(resolveMergeMethod(PROJECT, "/tmp/wt")).resolves.toBe("merge");

				mockGhRepoView("", "HTTP 502: Bad gateway", 1);
				await expect(resolveMergeMethod(PROJECT, "/tmp/wt")).resolves.toBe("squash");
			});
		});
	});
});
