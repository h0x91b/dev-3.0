import { beforeEach, describe, expect, it, vi } from "vitest";

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
					{ login: "h0x91b-wix", host: "github.com", active: false, state: "success" },
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
				{ login: "h0x91b-wix", host: "github.com", active: false },
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
							{ login: "h0x91b-wix", host: "github.com", active: false, state: "success" },
						],
					},
				}));
			}
			if (cmd.join(" ") === "gh auth token --hostname github.com --user h0x91b-wix") {
				return fakeProc("secret-token\n");
			}
			throw new Error(`Unexpected command: ${cmd.join(" ")}`);
		});

		const { getGitHubAuthEnv } = await import("../github");
		await expect(getGitHubAuthEnv({
			githubAuthHost: "github.com",
			githubAuthLogin: "h0x91b-wix",
		})).resolves.toEqual({
			GH_TOKEN: "secret-token",
			GITHUB_TOKEN: "secret-token",
		});
	});

	it("falls back to plain gh auth status when --json flag is unsupported (old gh)", async () => {
		whichMock.mockResolvedValue("/usr/bin/gh");
		spawnMock.mockImplementation((cmd: string[]) => {
			if (cmd.join(" ") === "gh auth status --json hosts") {
				return fakeProc("", "unknown flag: --json\n\nUsage:\n  gh auth status [flags]\n", 1);
			}
			if (cmd.join(" ") === "gh auth status") {
				// Old gh writes auth status output to stderr.
				const text =
					"github.com\n" +
					"  ✓ Logged in to github.com as h0x91b (oauth_token)\n" +
					"  ✓ Git operations for github.com configured to use https protocol.\n" +
					"  ✓ Token: gho_******\n";
				return fakeProc("", text, 0);
			}
			throw new Error(`Unexpected command: ${cmd.join(" ")}`);
		});

		const { getGitHubCliStatus } = await import("../github");
		await expect(getGitHubCliStatus()).resolves.toEqual({
			authStatus: "authenticated",
			binaryPath: "/usr/bin/gh",
			accounts: [{ login: "h0x91b", host: "github.com", active: true }],
		});
	});

	it("fallback parses plain output written to stdout instead of stderr", async () => {
		whichMock.mockResolvedValue("/usr/bin/gh");
		spawnMock.mockImplementation((cmd: string[]) => {
			if (cmd.join(" ") === "gh auth status --json hosts") {
				return fakeProc("", "unknown flag: --json\n", 1);
			}
			if (cmd.join(" ") === "gh auth status") {
				const text =
					"github.com\n" +
					"  ✓ Logged in to github.com as h0x91b-wix (keyring)\n" +
					"  ✓ Logged in to github.com as h0x91b (oauth_token)\n";
				return fakeProc(text, "", 0);
			}
			throw new Error(`Unexpected command: ${cmd.join(" ")}`);
		});

		const { getGitHubCliStatus } = await import("../github");
		const status = await getGitHubCliStatus();
		expect(status.authStatus).toBe("authenticated");
		expect(status.accounts).toEqual([
			{ login: "h0x91b-wix", host: "github.com", active: true },
			{ login: "h0x91b", host: "github.com", active: false },
		]);
	});

	it("fallback parses modern plain wording ('account X' instead of 'as X')", async () => {
		whichMock.mockResolvedValue("/opt/homebrew/bin/gh");
		spawnMock.mockImplementation((cmd: string[]) => {
			if (cmd.join(" ") === "gh auth status --json hosts") {
				return fakeProc("", "unknown flag: --json\n\nUsage:  gh auth status [flags]\n", 1);
			}
			if (cmd.join(" ") === "gh auth status") {
				// gh ~2.50+ (e.g. v2.63.2) wording: "Logged in to <host> account <login>".
				const text =
					"github.com\n" +
					"  ✓ Logged in to github.com account barvolovski (keyring)\n" +
					"  - Active account: true\n" +
					"  - Git operations protocol: https\n" +
					"  - Token: gho_******\n" +
					"  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'\n";
				return fakeProc(text, "", 0);
			}
			throw new Error(`Unexpected command: ${cmd.join(" ")}`);
		});

		const { getGitHubCliStatus } = await import("../github");
		await expect(getGitHubCliStatus()).resolves.toEqual({
			authStatus: "authenticated",
			binaryPath: "/opt/homebrew/bin/gh",
			accounts: [{ login: "barvolovski", host: "github.com", active: true }],
		});
	});

	it("fallback marks the account flagged 'Active account: true' as active, not the first listed", async () => {
		whichMock.mockResolvedValue("/opt/homebrew/bin/gh");
		spawnMock.mockImplementation((cmd: string[]) => {
			if (cmd.join(" ") === "gh auth status --json hosts") {
				return fakeProc("", "unknown flag: --json\n", 1);
			}
			if (cmd.join(" ") === "gh auth status") {
				const text =
					"github.com\n" +
					"  ✓ Logged in to github.com account h0x91b-wix (keyring)\n" +
					"  - Active account: false\n" +
					"\n" +
					"  ✓ Logged in to github.com account h0x91b (keyring)\n" +
					"  - Active account: true\n";
				return fakeProc(text, "", 0);
			}
			throw new Error(`Unexpected command: ${cmd.join(" ")}`);
		});

		const { getGitHubCliStatus } = await import("../github");
		const status = await getGitHubCliStatus();
		expect(status.authStatus).toBe("authenticated");
		expect(status.accounts).toEqual([
			{ login: "h0x91b", host: "github.com", active: true },
			{ login: "h0x91b-wix", host: "github.com", active: false },
		]);
	});

	it("returns not_authenticated when fallback gh auth status also fails", async () => {
		whichMock.mockResolvedValue("/usr/bin/gh");
		spawnMock.mockImplementation((cmd: string[]) => {
			if (cmd.join(" ") === "gh auth status --json hosts") {
				return fakeProc("", "unknown flag: --json\n", 1);
			}
			if (cmd.join(" ") === "gh auth status") {
				return fakeProc("", "You are not logged into any GitHub hosts.\n", 1);
			}
			throw new Error(`Unexpected command: ${cmd.join(" ")}`);
		});

		const { getGitHubCliStatus } = await import("../github");
		await expect(getGitHubCliStatus()).resolves.toEqual({
			authStatus: "not_authenticated",
			binaryPath: "/usr/bin/gh",
			accounts: [],
		});
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
							{ login: "h0x91b-wix", host: "github.com", active: true, state: "success", tokenSource: "GH_TOKEN" },
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
			await expect(getGitHubAuthEnv({ githubAuthHost: "github.com", githubAuthLogin: "h0x91b-wix" }))
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
							{ login: "h0x91b-wix", host: "github.com", active: true, state: "success", tokenSource: "GH_TOKEN" },
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
			await expect(getGitHubAuthEnv({ githubAuthHost: "github.com", githubAuthLogin: "h0x91b-wix" }))
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
					{ login: "h0x91b-wix", host: "github.com", active: true, state: "success", tokenSource: "GH_TOKEN" },
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

	describe("isPullRequestMerged", () => {
		const PROJECT = { githubAuthHost: "github.com", githubAuthLogin: "h0x91b" };

		function mockGhPrView(state: string | null, ok = true, headRefName = "feat/mine") {
			whichMock.mockResolvedValue("/opt/homebrew/bin/gh");
			spawnMock.mockImplementation((cmd: string[]) => {
				if (cmd.join(" ") === "gh auth status --json hosts") {
					return fakeProc(JSON.stringify({
						hosts: { "github.com": [{ login: "h0x91b", host: "github.com", active: true, state: "success" }] },
					}));
				}
				if (cmd[1] === "auth" && cmd[2] === "token") return fakeProc("secret-token\n");
				if (!ok) return fakeProc("", "no such PR", 1);
				return fakeProc(JSON.stringify({ state, headRefName }));
			});
		}

		it("returns true for a merged PR on this branch", async () => {
			mockGhPrView("MERGED");
			const { isPullRequestMerged } = await import("../github");
			await expect(isPullRequestMerged(PROJECT, "/tmp/wt", 1077, "feat/mine")).resolves.toBe(true);
		});

		it("returns false for an open PR", async () => {
			mockGhPrView("OPEN");
			const { isPullRequestMerged } = await import("../github");
			await expect(isPullRequestMerged(PROJECT, "/tmp/wt", 1077, "feat/mine")).resolves.toBe(false);
		});

		it("returns false when the gh command fails (offline / unauthenticated)", async () => {
			mockGhPrView(null, false);
			const { isPullRequestMerged } = await import("../github");
			await expect(isPullRequestMerged(PROJECT, "/tmp/wt", 1077, "feat/mine")).resolves.toBe(false);
		});

		it("refuses a merged PR that belongs to another branch", async () => {
			mockGhPrView("MERGED", true, "contributor/their-feature");
			const { isPullRequestMerged, _resetPullRequestMergedCache } = await import("../github");
			_resetPullRequestMergedCache();
			await expect(isPullRequestMerged(PROJECT, "/tmp/wt", 1255, "fix/mine")).resolves.toBe(false);
		});

		it("accepts a merged PR without an ownership check when no branch is known", async () => {
			mockGhPrView("MERGED", true, "contributor/their-feature");
			const { isPullRequestMerged, _resetPullRequestMergedCache } = await import("../github");
			_resetPullRequestMergedCache();
			await expect(isPullRequestMerged(PROJECT, "/tmp/wt", 1255, null)).resolves.toBe(true);
		});

		it("reports state and head branch via getPullRequestSnapshot", async () => {
			mockGhPrView("MERGED", true, "contributor/their-feature");
			const { getPullRequestSnapshot, _resetPullRequestMergedCache } = await import("../github");
			_resetPullRequestMergedCache();
			await expect(getPullRequestSnapshot(PROJECT, "/tmp/wt", 1255)).resolves.toEqual({
				state: "MERGED",
				headRefName: "contributor/their-feature",
			});
		});

		it("caches a merged answer instead of re-asking gh", async () => {
			mockGhPrView("MERGED");
			const { isPullRequestMerged, _resetPullRequestMergedCache } = await import("../github");
			_resetPullRequestMergedCache();
			await isPullRequestMerged(PROJECT, "/tmp/wt", 1077, "feat/mine");
			const callsAfterFirst = spawnMock.mock.calls.length;
			await isPullRequestMerged(PROJECT, "/tmp/wt", 1077, "feat/mine");
			expect(spawnMock.mock.calls.length).toBe(callsAfterFirst);
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

		it("recognises gh's refusal on a non-GitHub remote", async () => {
			const { isNotAGitHubRepoError } = await import("../github");
			expect(isNotAGitHubRepoError({
				stderr: "none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`",
			})).toBe(true);
			expect(isNotAGitHubRepoError({ stdout: "no git remotes found" })).toBe(true);
		});

		it("does NOT claim non-GitHub for any other failure", async () => {
			const { isNotAGitHubRepoError } = await import("../github");
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
				expect(isNotAGitHubRepoError({ stderr })).toBe(false);
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

		it("treats a successful gh call as GitHub", async () => {
			mockGhRepoView('{"nameWithOwner":"h0x91b/dev-3.0"}');
			const { isGitHubRepo } = await import("../github");
			await expect(isGitHubRepo(PROJECT, "/tmp/wt")).resolves.toBe(true);
		});

		it("reports not-GitHub when gh says the remotes are not GitHub", async () => {
			mockGhRepoView("", "none of the git remotes configured for this repository point to a known GitHub host.", 1);
			const { isGitHubRepo } = await import("../github");
			await expect(isGitHubRepo(PROJECT, "/tmp/wt")).resolves.toBe(false);
		});

		/** A blip must not disable the button — the whole point of the polarity. */
		it("stays GitHub when gh fails for any other reason", async () => {
			mockGhRepoView("", "HTTP 502: Bad gateway", 1);
			const { isGitHubRepo } = await import("../github");
			await expect(isGitHubRepo(PROJECT, "/tmp/wt")).resolves.toBe(true);
		});

		describe("findOpenPullRequest", () => {
			it("returns the PR gh listed for the branch", async () => {
				mockGhRepoView(JSON.stringify([{ number: 1475, url: "https://github.com/h0x91b/dev-3.0/pull/1475" }]));
				const { findOpenPullRequest } = await import("../github");
				await expect(findOpenPullRequest(PROJECT, "/tmp/wt", "dev3/t")).resolves.toEqual({
					pr: { number: 1475, url: "https://github.com/h0x91b/dev-3.0/pull/1475", title: null, author: null },
					isGitHub: true,
				});
			});

			// The two fields a review task is named after. A GitHub display name is
			// optional, so the login has to carry the naming when it is missing.
			it("prefers the author's display name and falls back to the login", async () => {
				const { findOpenPullRequest } = await import("../github");
				mockGhRepoView(JSON.stringify([
					{ number: 1, url: "u", title: "Pin tmux", author: { login: "h0x91b", name: "Arseny Pavlenko" } },
				]));
				await expect(findOpenPullRequest(PROJECT, "/tmp/wt", "b")).resolves.toMatchObject({
					pr: { title: "Pin tmux", author: "Arseny Pavlenko" },
				});

				mockGhRepoView(JSON.stringify([{ number: 1, url: "u", title: "", author: { login: "h0x91b", name: "" } }]));
				await expect(findOpenPullRequest(PROJECT, "/tmp/wt", "b")).resolves.toMatchObject({
					pr: { title: null, author: "h0x91b" },
				});

				mockGhRepoView(JSON.stringify([{ number: 1, url: "u" }]));
				await expect(findOpenPullRequest(PROJECT, "/tmp/wt", "b")).resolves.toMatchObject({
					pr: { title: null, author: null },
				});
			});

			// Three different gh answers, one meaning for the caller: no PR. Merge reads
			// this to choose its route, so "could not tell" must never read as "there is one".
			it("reports no PR for an empty list, a failure, and unparsable output", async () => {
				const { findOpenPullRequest } = await import("../github");
				for (const [stdout, stderr, code] of [["[]", "", 0], ["", "gh: not found", 1], ["not json", "", 0]] as const) {
					mockGhRepoView(stdout, stderr, code);
					const probe = await findOpenPullRequest(PROJECT, "/tmp/wt", "dev3/t");
					expect(probe.pr).toBeNull();
				}
			});

			it("carries gh's non-GitHub verdict, and asks nothing without a branch", async () => {
				mockGhRepoView("", "none of the git remotes configured for this repository point to a known GitHub host.", 1);
				const { findOpenPullRequest } = await import("../github");
				await expect(findOpenPullRequest(PROJECT, "/tmp/wt", "dev3/t")).resolves.toEqual({ pr: null, isGitHub: false });

				spawnMock.mockClear();
				await expect(findOpenPullRequest(PROJECT, "/tmp/wt", "")).resolves.toEqual({ pr: null, isGitHub: true });
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
