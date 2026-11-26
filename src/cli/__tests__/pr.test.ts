import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handlePr, realPrDeps, type PrCommandResult, type PrDeps } from "../commands/pr";
import { parseArgs, type ParsedArgs } from "../args";
import type { CliContext } from "../context";

vi.mock("../context", () => ({
	readTaskDirect: vi.fn(() => null),
	readProjectDirect: vi.fn(() => null),
}));

vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));

import { readProjectDirect, readTaskDirect } from "../context";
import { sendRequest } from "../socket-client";
const mockSendRequest = vi.mocked(sendRequest);
const mockReadTask = vi.mocked(readTaskDirect);
const mockReadProject = vi.mocked(readProjectDirect);

let stdoutOutput: string;
let stderrOutput: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

const CWD = "/repo";
const PR_URL = "https://github.com/acme/app/pull/42";

function args(flags: Record<string, string> = {}): ParsedArgs {
	return { positional: [], flags };
}

function ctx(overrides: Partial<CliContext> = {}): CliContext {
	return {
		projectId: "proj-1",
		taskId: "task-1",
		socketPath: "/tmp/x.sock",
		worktreePath: CWD,
		...overrides,
	};
}

const ok = (stdout = ""): PrCommandResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr: string): PrCommandResult => ({ status: 1, stdout: "", stderr });

const LOGGED_OUT_PROBE = "To get started with GitHub CLI, please run:  gh auth login";
const SANDBOX_TLS = 'Get "https://api.github.com/user": tls: failed to verify certificate: x509: OSStatus -26276';

interface Call {
	command: string;
	args: string[];
	cwd: string;
	env?: Record<string, string>;
}

/**
 * A fake process runner: `responses` maps a command prefix (the binary plus its
 * first two arguments, e.g. `gh pr create`) to what it returns. Anything not
 * listed succeeds silently, so a test only spells out what it cares about.
 */
function deps(
	responses: Record<string, PrCommandResult> = {},
	overrides: Partial<PrDeps> = {},
): { deps: PrDeps; calls: Call[] } {
	const calls: Call[] = [];
	const base: PrDeps = {
		run: (command, runArgs, cwd, env) => {
			calls.push({ command, args: runArgs, cwd, env });
			const key = [command, ...runArgs.slice(0, 2)].join(" ");
			for (const [prefix, result] of Object.entries(responses)) {
				if (key.startsWith(prefix)) return result;
			}
			if (command === "git" && runArgs[0] === "rev-parse") return ok("feat/thing\n");
			if (command === "gh" && runArgs[1] === "create") return ok(`${PR_URL}\n`);
			return ok();
		},
		cwd: CWD,
		platform: "darwin",
		originTaskLinkEnabled: () => true,
		watchUntilMerged: async () => false,
		...overrides,
	};
	return { deps: base, calls };
}

function ran(calls: Call[], command: string, firstArgs: string[]): Call | undefined {
	return calls.find((c) => c.command === command && firstArgs.every((a, i) => c.args[i] === a));
}

beforeEach(() => {
	stdoutOutput = "";
	stderrOutput = "";
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdoutOutput += String(chunk);
		return true;
	});
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderrOutput += String(chunk);
		return true;
	});
	exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
		throw new Error(`EXIT_${code ?? 0}`);
	}) as ReturnType<typeof vi.spyOn>;
	mockReadTask.mockReset();
	mockReadTask.mockReturnValue(null);
	mockReadProject.mockReset();
	mockReadProject.mockReturnValue(null);
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	exitSpy.mockRestore();
});

/** Routes by the full argument list, which the prefix table in `deps()` cannot tell apart. */
function forkRepo(
	base: PrDeps,
	{
		originDenied = true,
		remotes = "fork\norigin\n",
		urls = { origin: "https://github.com/acme/app", fork: "git@github.com:me/app.git" } as Record<string, string>,
		parent = "acme/app",
		config = {} as Record<string, string>,
	} = {},
): PrDeps {
	return {
		...base,
		run: (command, runArgs, cwd, env) => {
			const result = base.run(command, runArgs, cwd, env);
			if (command === "gh" && runArgs[0] === "repo") return ok(`${parent}\n`);
			if (command !== "git") return result;
			if (runArgs[0] === "push" && runArgs[2] === "origin" && originDenied) {
				return fail("remote: Permission to acme/app.git denied to me.\nfatal: The requested URL returned error: 403");
			}
			if (runArgs[0] === "config") return config[runArgs[2]] ? ok(`${config[runArgs[2]]}\n`) : fail("");
			if (runArgs[0] === "remote" && runArgs.length === 1) return ok(remotes);
			if (runArgs[1] === "get-url") return ok(`${urls[runArgs[runArgs.length - 1]] ?? ""}\n`);
			return result;
		},
	};
}

describe("dev3 pr create — fork contributors", () => {
	it("pushes to the only other remote when origin is not writable, and opens the PR on origin's repo (GHE host kept)", async () => {
		const cases = [
			{ urls: undefined, repo: "--repo acme/app" },
			{ urls: { origin: "https://ghe.example.com/acme/app.git", fork: "ssh://git@ghe.example.com:2222/me/app.git" }, repo: "--repo ghe.example.com/acme/app" },
		];
		for (const { urls, repo } of cases) {
			stdoutOutput = "";
			const { deps: d, calls } = deps();

			await handlePr("create", args({ title: "T" }), null, forkRepo(d, urls ? { urls } : {}));

			expect(ran(calls, "git", ["push", "--set-upstream", "fork"]), repo).toBeDefined();
			const create = ran(calls, "gh", ["pr", "create"])!;
			expect(create.args.join(" "), repo).toContain(repo);
			expect(create.args.join(" "), repo).toContain("--head me:feat/thing");
			expect(stdoutOutput, repo).toContain("feat/thing → fork");
		}
	});

	it("never guesses a push remote: not a non-fork remote, not one of several", async () => {
		const cases = [
			{ name: "not a fork", opts: { parent: "/" } },
			{ name: "several other remotes", opts: { remotes: "fork\nmirror\norigin\n" } },
		];
		for (const { name, opts } of cases) {
			stderrOutput = "";
			const { deps: d, calls } = deps();

			await expect(handlePr("create", args({ title: "T" }), null, forkRepo(d, opts)), name).rejects.toThrow(/EXIT_/);

			expect(ran(calls, "git", ["push", "--set-upstream", "fork"]), name).toBeUndefined();
			expect(ran(calls, "gh", ["pr", "create"]), name).toBeUndefined();
			expect(stderrOutput, name).toContain("remote.pushDefault");
		}
	});

	it("prefers the branch's pushRemote over remote.pushDefault, falls back to pushDefault, and never tries origin first", async () => {
		const cases: Array<Record<string, string>> = [
			{ "branch.feat/thing.pushRemote": "fork", "remote.pushDefault": "mirror" },
			{ "remote.pushDefault": "fork" },
		];
		for (const config of cases) {
			const { deps: d, calls } = deps();

			await handlePr("create", args({ title: "T" }), null, forkRepo(d, { config }));

			const label = JSON.stringify(config);
			expect(ran(calls, "git", ["push", "--set-upstream", "origin"]), label).toBeUndefined();
			expect(ran(calls, "git", ["push", "--set-upstream", "mirror"]), label).toBeUndefined();
			expect(ran(calls, "git", ["push", "--set-upstream", "fork"]), label).toBeDefined();
		}
	});

	it("names the owner of the push URL, not the fetch URL", async () => {
		const { deps: d, calls } = deps();
		const base = forkRepo(d, { config: { "remote.pushDefault": "fork" } });
		const withPushUrl: PrDeps = {
			...base,
			run: (command, runArgs, cwd, env) =>
				command === "git" && runArgs[1] === "get-url" && runArgs[2] === "--push" && runArgs[3] === "fork"
					? ok("https://github.com/me/app.git\n")
					: command === "git" && runArgs[1] === "get-url" && runArgs[2] === "fork"
						? ok("https://github.com/acme/app\n")
						: base.run(command, runArgs, cwd, env),
		};

		await handlePr("create", args({ title: "T" }), null, withPushUrl);

		expect(ran(calls, "gh", ["pr", "create"])!.args.join(" ")).toContain("--head me:feat/thing");
	});

	it("adds no --repo/--head for an ordinary origin push or a remote that is origin's own repository", async () => {
		const cases = [
			{ name: "origin writable", opts: { originDenied: false } },
			{
				name: "alias of origin",
				opts: { urls: { origin: "https://github.com/acme/app", alias: "git@github.com:acme/app.git" }, config: { "remote.pushDefault": "alias" } },
			},
		];
		for (const { name, opts } of cases) {
			const { deps: d, calls } = deps();

			await handlePr("create", args({ title: "T" }), null, forkRepo(d, opts));

			const create = ran(calls, "gh", ["pr", "create"])!;
			expect(create.args, name).not.toContain("--repo");
			expect(create.args, name).not.toContain("--head");
		}
	});
});

describe("dev3 pr create — merge watch", () => {
	it("subscribes the task's agent to the merge, and never outside a task", async () => {
		const watchUntilMerged = vi.fn(async () => true);
		const context = ctx();

		await handlePr("create", args({ title: "T" }), context, deps({}, { watchUntilMerged }).deps);

		expect(watchUntilMerged).toHaveBeenCalledWith(context);
		expect(stdoutOutput).toContain("until merged");
		expect(stdoutOutput).not.toContain("Waiting on CI or merge?");

		watchUntilMerged.mockClear();
		await handlePr("create", args({ title: "T" }), null, deps({}, { watchUntilMerged }).deps);
		expect(watchUntilMerged).not.toHaveBeenCalled();
	});

	it("arms the watch before auto-merge, so a refused auto-merge still leaves the PR watched", async () => {
		const watchUntilMerged = vi.fn(async () => true);
		const { deps: d } = deps({ "gh pr merge": fail("auto-merge is not allowed") }, { watchUntilMerged });

		await expect(handlePr("create", args({ title: "T", "auto-merge": "true" }), ctx(), d)).rejects.toThrow(/EXIT_/);

		expect(watchUntilMerged).toHaveBeenCalled();
	});

	it("asks the app for the branch's own PR with until merged, from this agent; reports no watch when unreachable", async () => {
		mockSendRequest.mockResolvedValue({ ok: true, data: { prNumber: 42 } } as never);

		expect(await realPrDeps.watchUntilMerged(ctx())).toBe(true);

		const [socket, method, params] = mockSendRequest.mock.calls[0];
		expect(socket).toBe("/tmp/x.sock");
		expect(method).toBe("pr.watch.add");
		expect(params).toMatchObject({ taskId: "task-1", projectId: "proj-1", until: "merged", sourceTaskId: "task-1" });
		expect(params).not.toHaveProperty("prNumber");

		mockSendRequest.mockRejectedValue(new Error("ECONNREFUSED"));
		expect(await realPrDeps.watchUntilMerged(ctx())).toBe(false);
	});
});

describe("dev3 pr create — happy path", () => {
	it("pushes the branch, opens the pull request, and prints its URL even amid gh chatter", async () => {
		const { deps: d, calls } = deps({
			"gh pr create": ok(`Creating pull request for feat/thing into main\n\n${PR_URL}\n`),
		});

		await handlePr("create", args({ title: "Add a thing", description: "Why it exists", draft: "true" }), null, d);

		expect(ran(calls, "git", ["push", "--set-upstream", "origin", "feat/thing:refs/heads/feat/thing"])).toBeDefined();
		const create = ran(calls, "gh", ["pr", "create"])!;
		expect(create.args).toContain("Add a thing");
		expect(create.args).toContain("Why it exists");
		expect(create.args).toContain("--draft");
		expect(create.cwd).toBe(CWD);
		expect(stdoutOutput).toContain("feat/thing → origin");
		expect(stdoutOutput).toContain(PR_URL);
	});

	it("in a task runs in its worktree and points the agent at `dev3 pr watch` after the URL; not outside a task", async () => {
		const { deps: d, calls } = deps({}, { cwd: "/somewhere/else" });
		await handlePr("create", args({ title: "T" }), ctx({ worktreePath: "/wt" }), d);
		expect(ran(calls, "git", ["push"])!.cwd).toBe("/wt");
		expect(stdoutOutput).toContain("dev3 pr watch");
		expect(stdoutOutput.indexOf(PR_URL)).toBeLessThan(stdoutOutput.indexOf("dev3 pr watch"));

		stdoutOutput = "";
		await handlePr("create", args({ title: "T" }), null, deps().deps);
		expect(stdoutOutput).not.toContain("dev3 pr watch");
	});

	it("on an Operations task succeeds and prints a short info line instead of the watch hint", async () => {
		mockReadProject.mockReturnValue({ id: "proj-1", name: "Operations", path: "", kind: "virtual" } as never);
		const { deps: d } = deps();

		await handlePr("create", args({ title: "T" }), ctx(), d);

		expect(stdoutOutput).toContain(PR_URL);
		expect(stdoutOutput).toContain("PR watch is not available for Operations tasks");
		expect(stdoutOutput).not.toContain("dev3 pr watch");
		expect(exitSpy).not.toHaveBeenCalled();
	});
});

describe("dev3 pr create — --assignee", () => {
	function assigneeArgs(call: Call | undefined): string[] {
		const out: string[] = [];
		call!.args.forEach((a, i) => {
			if (a === "--assignee") out.push(call!.args[i + 1]);
		});
		return out;
	}

	it("passes none, one, or repeated and comma-separated logins through to gh", async () => {
		const cases: Array<[string[], string[]]> = [
			[[], []],
			[["--assignee", "octocat"], ["octocat"]],
			[["--assignee", "alice, bob", "--assignee", "@me"], ["alice", "bob", "@me"]],
		];
		for (const [flag, expected] of cases) {
			const { deps: d, calls } = deps();

			await handlePr("create", parseArgs(["--title", "T", ...flag]), null, d);

			expect(assigneeArgs(ran(calls, "gh", ["pr", "create"])), JSON.stringify(flag)).toEqual(expected);
		}
	});

	it("refuses --assignee with no login (bare, or only separators) before pushing", async () => {
		for (const flag of [["--assignee"], ["--assignee", ","]]) {
			const { deps: d, calls } = deps();

			await expect(handlePr("create", parseArgs(["--title", "T", ...flag]), null, d), JSON.stringify(flag)).rejects.toThrow("EXIT_3");

			expect(ran(calls, "git", ["push"]), JSON.stringify(flag)).toBeUndefined();
			expect(ran(calls, "gh", ["pr", "create"]), JSON.stringify(flag)).toBeUndefined();
		}
	});
});

describe("dev3 pr create — gh must be installed and logged in", () => {
	it("exits 23 and pushes nothing when gh is absent", async () => {
		const { deps: d, calls } = deps({ "gh --version": { status: null, stdout: "", stderr: "ENOENT" } });

		await expect(handlePr("create", args({ title: "T" }), null, d)).rejects.toThrow("EXIT_23");

		expect(ran(calls, "git", ["push"])).toBeUndefined();
		expect(stderrOutput).toContain("gh auth login");
	});

	it("exits 23 when gh is not authenticated, checking auth before touching git at all", async () => {
		const { deps: d, calls } = deps({ "gh auth status": fail("You are not logged into any GitHub hosts"), "gh api user": fail(LOGGED_OUT_PROBE) });

		await expect(handlePr("create", args({ title: "T" }), null, d)).rejects.toThrow("EXIT_23");

		expect(calls.every((c) => c.command === "gh")).toBe(true);
		expect(ran(calls, "gh", ["pr", "create"])).toBeUndefined();
		expect(stderrOutput).toContain("not authenticated");
	});
});

// h0x91b/dev-3.0#1925: under an agent sandbox Go's TLS check fails, and `gh auth
// status` words that as an invalid token. Re-login advice there is a dead end.
describe("dev3 pr create — a blocked TLS check is not a logout", () => {
	it("exits 28, pushes nothing and never sends the agent to re-login when auth status shows the TLS error", async () => {
		const { deps: d, calls } = deps({ "gh auth status": fail(SANDBOX_TLS) });

		await expect(handlePr("create", args({ title: "T" }), null, d)).rejects.toThrow("EXIT_28");

		expect(ran(calls, "git", ["push"])).toBeUndefined();
		expect(ran(calls, "gh", ["api", "user"])).toBeUndefined();
		expect(stderrOutput).toContain("NOT a credential problem");
		expect(stderrOutput).not.toContain("Run `gh auth login`");
	});

	it("exits 28 when auth status calls the token invalid but a read-only probe hits the TLS error", async () => {
		const { deps: d, calls } = deps({
			"gh auth status": fail("X Failed to log in to github.com account octo (keyring)\n- The token in keyring is invalid."),
			"gh api user": fail(SANDBOX_TLS),
		});

		await expect(handlePr("create", args({ title: "T" }), null, d)).rejects.toThrow("EXIT_28");

		expect(ran(calls, "git", ["push"])).toBeUndefined();
		expect(ran(calls, "gh", ["api", "user"])?.args).toEqual(["api", "user", "--jq", ".login"]);
		expect(stderrOutput).toContain("OSStatus -26276");
		expect(stderrOutput).not.toContain("Run `gh auth login`");
	});

	it("still exits 23 for credentials GitHub really rejects", async () => {
		const { deps: d, calls } = deps({
			"gh auth status": fail("The token in keyring is invalid."),
			"gh api user": fail("gh: Bad credentials (HTTP 401)"),
		});

		await expect(handlePr("create", args({ title: "T" }), null, d)).rejects.toThrow("EXIT_23");

		expect(ran(calls, "git", ["push"])).toBeUndefined();
		expect(stderrOutput).toContain("Run `gh auth login`");
	});

	it("goes ahead when auth status fails but an authenticated call succeeds", async () => {
		const { deps: d, calls } = deps({ "gh auth status": fail("The token in keyring is invalid."), "gh api user": ok("octo\n") });

		await handlePr("create", args({ title: "T" }), null, d);

		expect(ran(calls, "gh", ["pr", "create"])).toBeDefined();
	});

	it("explains a TLS failure of gh pr create itself and says the branch is already pushed", async () => {
		const { deps: d, calls } = deps({ "gh pr create": fail(SANDBOX_TLS) });

		await expect(handlePr("create", args({ title: "T" }), null, d)).rejects.toThrow("EXIT_1");

		expect(calls.filter((c) => c.command === "gh" && c.args[1] === "create")).toHaveLength(1);
		expect(stderrOutput).toContain("already pushed");
		expect(stderrOutput).toContain("NOT a credential problem");
	});

	it("leaves an ordinary gh pr create failure untouched", async () => {
		const { deps: d } = deps({ "gh pr create": fail("a pull request for branch already exists") });

		await expect(handlePr("create", args({ title: "T" }), null, d)).rejects.toThrow("EXIT_1");

		expect(stderrOutput).toContain("already exists");
		expect(stderrOutput).not.toContain("credential");
	});

	it("auto-merge refuses a blocked TLS check with exit 28 too", async () => {
		const { deps: d, calls } = deps({ "gh auth status": fail(SANDBOX_TLS) });

		await expect(handlePr("auto-merge", args(), null, d)).rejects.toThrow("EXIT_28");

		expect(ran(calls, "gh", ["pr", "merge"])).toBeUndefined();
	});
});

describe("dev3 pr create — the origin-task footer", () => {
	function bodyOf(calls: Call[]): string {
		const create = ran(calls, "gh", ["pr", "create"])!;
		return create.args[create.args.indexOf("--body") + 1];
	}

	it("links back to the task when run inside a task worktree", async () => {
		const { deps: d, calls } = deps();

		await handlePr("create", args({ title: "T", description: "Body" }), ctx(), d);

		const body = bodyOf(calls);
		expect(body).toContain("Body");
		expect(body).toContain("Origin task in dev3");
		expect(body).toContain("open.html?task=task-1");
	});

	// A dev3:// link is dead anywhere the scheme is not registered, and a PR body
	// is public — so the host decides before the preference does.
	it("omits the footer outside a task, when turned off, and where no dev3:// handler exists; empty body without --description", async () => {
		const cases: Array<{ name: string; context: CliContext | null; overrides: Partial<PrDeps>; description?: string; body: string }> = [
			{ name: "outside a task", context: null, overrides: {}, description: "Body", body: "Body" },
			{ name: "turned off", context: ctx(), overrides: { originTaskLinkEnabled: () => false }, description: "Body", body: "Body" },
			{ name: "linux host", context: ctx(), overrides: { platform: "linux" }, description: "Body", body: "Body" },
			{ name: "no description", context: null, overrides: {}, body: "" },
		];
		for (const { name, context, overrides, description, body } of cases) {
			const { deps: d, calls } = deps({}, overrides);

			await handlePr("create", args(description ? { title: "T", description } : { title: "T" }), context, d);

			expect(bodyOf(calls), name).toBe(body);
		}
	});
});

describe("dev3 pr create — the base branch", () => {
	it("defaults to the task's base branch, lets --base win, and omits --base with neither", async () => {
		mockReadTask.mockReturnValue({ baseBranch: "develop" });
		const baseOf = (call: Call) => call.args[call.args.indexOf("--base") + 1];

		const first = deps();
		await handlePr("create", args({ title: "T" }), ctx(), first.deps);
		expect(baseOf(ran(first.calls, "gh", ["pr", "create"])!)).toBe("develop");
		expect(stdoutOutput).toContain("develop");

		const second = deps();
		await handlePr("create", args({ title: "T", base: "release/9" }), ctx(), second.deps);
		expect(baseOf(ran(second.calls, "gh", ["pr", "create"])!)).toBe("release/9");

		const third = deps();
		await handlePr("create", args({ title: "T" }), null, third.deps);
		expect(ran(third.calls, "gh", ["pr", "create"])!.args).not.toContain("--base");
	});

	it("refuses when the checked-out branch IS the base branch; in a shared folder without telling it to branch", async () => {
		mockReadTask.mockReturnValue({ baseBranch: "main" });
		const cases = [
			{ name: "worktree", project: null, contains: "Create a branch", absent: "do not create or switch a branch here" },
			{ name: "shared folder", project: { id: "p", name: "P", path: "/p", gitWorkflow: false }, contains: "do not create or switch a branch here", absent: "Create a branch" },
		];
		for (const { name, project, contains, absent } of cases) {
			stderrOutput = "";
			mockReadProject.mockReturnValue(project as never);
			const { deps: d, calls } = deps({ "git rev-parse": ok("main\n") });

			await expect(handlePr("create", args({ title: "T" }), ctx(), d), name).rejects.toThrow("EXIT_1");

			expect(ran(calls, "git", ["push"]), name).toBeUndefined();
			expect(stderrOutput, name).toContain("base branch");
			expect(stderrOutput, name).toContain(contains);
			expect(stderrOutput, name).not.toContain(absent);
		}
	});
});

describe("dev3 pr create — auto-merge", () => {
	it("never enables auto-merge unless asked, squashes by default, and accepts a named strategy", async () => {
		const unasked = deps();
		await handlePr("create", args({ title: "T" }), null, unasked.deps);
		expect(ran(unasked.calls, "gh", ["pr", "merge"])).toBeUndefined();

		const squash = deps();
		await handlePr("create", args({ title: "T", "auto-merge": "true" }), null, squash.deps);
		expect(ran(squash.calls, "gh", ["pr", "merge"])!.args).toEqual(["pr", "merge", "--auto", "--squash", PR_URL]);
		expect(stdoutOutput).toContain("Auto-merge   enabled (squash)");

		const rebase = deps();
		await handlePr("create", args({ title: "T", "auto-merge": "rebase" }), null, rebase.deps);
		expect(ran(rebase.calls, "gh", ["pr", "merge"])!.args).toContain("--rebase");
	});

	it("rejects a strategy gh does not have", async () => {
		const { deps: d, calls } = deps();

		await expect(handlePr("create", args({ title: "T", "auto-merge": "fastforward" }), null, d)).rejects.toThrow("EXIT_3");

		expect(calls).toEqual([]);
	});

	// The pull request is already open at this point: reporting only the failure
	// would read as "no pull request was created".
	it("still reports the pull request when auto-merge cannot be enabled", async () => {
		const { deps: d } = deps({ "gh pr merge": fail("Auto-merge is not enabled for this repository") });

		await expect(handlePr("create", args({ title: "T", "auto-merge": "true" }), null, d)).rejects.toThrow("EXIT_1");

		expect(stdoutOutput).toContain(PR_URL);
		expect(stderrOutput).toContain("auto-merge (squash) could not be enabled");
	});
});

describe("dev3 pr auto-merge", () => {
	it("squashes the current branch's PR by default in the task's worktree, without touching git", async () => {
		const { deps: d, calls } = deps({}, { cwd: "/somewhere/else" });

		await handlePr("auto-merge", args(), ctx({ worktreePath: "/wt" }), d);

		const merge = ran(calls, "gh", ["pr", "merge"])!;
		expect(merge.args).toEqual(["pr", "merge", "--auto", "--squash"]);
		expect(merge.cwd).toBe("/wt");
		expect(calls.every((c) => c.command === "gh")).toBe(true);
		expect(stdoutOutput).toContain("Auto-merge   enabled (squash)");
	});

	it("accepts a strategy and an explicit pull request, and clears with --off", async () => {
		const explicit = deps();
		await handlePr("auto-merge", { positional: ["1722"], flags: { strategy: "rebase" } }, null, explicit.deps);
		expect(ran(explicit.calls, "gh", ["pr", "merge"])!.args).toEqual(["pr", "merge", "--auto", "--rebase", "1722"]);
		expect(stdoutOutput).toContain("on 1722");

		const off = deps();
		await handlePr("auto-merge", args({ off: "true" }), null, off.deps);
		expect(ran(off.calls, "gh", ["pr", "merge"])!.args).toEqual(["pr", "merge", "--disable-auto"]);
		expect(stdoutOutput).toContain("cleared");
	});

	it("needs an authenticated gh too", async () => {
		const { deps: d, calls } = deps({ "gh auth status": fail("logged out"), "gh api user": fail(LOGGED_OUT_PROBE) });

		await expect(handlePr("auto-merge", args(), null, d)).rejects.toThrow("EXIT_23");

		expect(ran(calls, "gh", ["pr", "merge"])).toBeUndefined();
	});

	it("rejects --off together with --strategy, and a strategy gh does not have", async () => {
		for (const flags of [{ off: "true", strategy: "squash" }, { strategy: "fastforward" }] as Array<Record<string, string>>) {
			const { deps: d, calls } = deps();

			await expect(handlePr("auto-merge", args(flags), null, d), JSON.stringify(flags)).rejects.toThrow("EXIT_3");

			expect(calls, JSON.stringify(flags)).toEqual([]);
		}
	});

	/**
	 * `dev3 pr auto-merge --off 1722` parses as `off="1722"` with NO positional, because
	 * a bare `--flag` swallows the next token. Read as a boolean that is "not true", it
	 * did the exact opposite of the request — it ENABLED auto-merge on the branch's own
	 * pull request, and one of ours merged that way. It must refuse instead.
	 */
	it("refuses --off with a value instead of silently enabling auto-merge", async () => {
		const { deps: d, calls } = deps();

		await expect(handlePr("auto-merge", args({ off: "1722" }), null, d)).rejects.toThrow("EXIT_3");

		expect(calls).toEqual([]);
		expect(stderrOutput).toContain("takes no value");
		expect(stderrOutput).toContain("dev3 pr auto-merge 1722 --off");
	});

	it("surfaces what gh said when it cannot be enabled", async () => {
		const { deps: d } = deps({ "gh pr merge": fail("Pull request is not mergeable") });

		await expect(handlePr("auto-merge", args(), null, d)).rejects.toThrow("EXIT_1");

		expect(stderrOutput).toContain("not mergeable");
	});
});

describe("dev3 pr create — refusals", () => {
	it("exits 3 before running anything on usage errors", async () => {
		const cases: Array<{ name: string; sub: string | undefined; flags: Record<string, string> }> = [
			{ name: "missing --title", sub: "create", flags: { description: "b" } },
			{ name: "blank --title", sub: "create", flags: { title: "   " } },
			{ name: "unknown flag", sub: "create", flags: { title: "T", bogus: "1" } },
			{ name: "unknown subcommand", sub: "list", flags: {} },
			{ name: "missing subcommand", sub: undefined, flags: { title: "T" } },
		];
		for (const { name, sub, flags } of cases) {
			const { deps: d, calls } = deps();

			await expect(handlePr(sub, args(flags), null, d), name).rejects.toThrow("EXIT_3");

			expect(calls, name).toEqual([]);
		}
	});

	// Same value-eating trap as `--off`: a switch that got a value was mistyped.
	it("refuses --draft with a value and --description with no value", async () => {
		for (const flags of [{ title: "T", draft: "yes" }, { title: "T", description: "true" }] as Array<Record<string, string>>) {
			const { deps: d, calls } = deps();

			await expect(handlePr("create", args(flags), null, d), JSON.stringify(flags)).rejects.toThrow("EXIT_3");

			expect(calls, JSON.stringify(flags)).toEqual([]);
		}
		expect(stderrOutput).toContain("--description needs a value");
	});

	it("refuses on a detached HEAD and reports a git failure outside a repository, without pushing", async () => {
		const cases = [
			{ result: ok("HEAD\n"), message: "detached" },
			{ result: fail("fatal: not a git repository"), message: "not a git repository" },
		];
		for (const { result, message } of cases) {
			stderrOutput = "";
			const { deps: d, calls } = deps({ "git rev-parse": result });

			await expect(handlePr("create", args({ title: "T" }), null, d), message).rejects.toThrow("EXIT_1");

			expect(ran(calls, "git", ["push"]), message).toBeUndefined();
			expect(stderrOutput).toContain(message);
		}
	});

	it("stops before gh when the push fails", async () => {
		const { deps: d, calls } = deps({ "git push": fail("! [rejected] non-fast-forward") });

		await expect(handlePr("create", args({ title: "T" }), null, d)).rejects.toThrow("EXIT_1");

		expect(ran(calls, "gh", ["pr", "create"])).toBeUndefined();
		expect(stderrOutput).toContain("non-fast-forward");
	});
});

describe("dev3 pr — the project's GitHub account", () => {
	const TOKEN = "gho_project_token_value";
	const savedEnv: Record<string, string | undefined> = {};
	const TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

	beforeEach(() => {
		for (const name of TOKEN_VARS) {
			savedEnv[name] = process.env[name];
			delete process.env[name];
		}
	});
	afterEach(() => {
		for (const name of TOKEN_VARS) {
			if (savedEnv[name] === undefined) delete process.env[name];
			else process.env[name] = savedEnv[name];
		}
	});

	function withAccount(login: string | null, host?: string) {
		mockReadProject.mockReturnValue({ id: "proj-1", name: "p", path: "/repo", githubAuthLogin: login, githubAuthHost: host ?? null });
	}

	it("runs push, create and merge as the configured account, token only in the child env", async () => {
		withAccount("work-bot");
		const { deps: d, calls } = deps({ "gh auth token": ok(`${TOKEN}\n`) });

		await handlePr("create", args({ title: "T", "auto-merge": "true" }), ctx(), d);

		const tokenCall = ran(calls, "gh", ["auth", "token"])!;
		expect(tokenCall.args).toEqual(["auth", "token", "--hostname", "github.com", "--user", "work-bot"]);
		expect(tokenCall.env).toMatchObject({ GH_TOKEN: "", GITHUB_TOKEN: "" });
		for (const call of [ran(calls, "gh", ["auth", "status"]), ran(calls, "git", ["push"]), ran(calls, "gh", ["pr", "create"]), ran(calls, "gh", ["pr", "merge"])]) {
			expect(call?.env).toMatchObject({ GH_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN });
		}
		expect(calls.some((c) => c.command === "gh" && c.args[0] === "auth" && c.args[1] === "switch")).toBe(false);
		expect(stdoutOutput).toContain("acting as work-bot@github.com");
		expect(stdoutOutput + stderrOutput).not.toContain(TOKEN);
	});

	it("uses the enterprise variables for a GHES host", async () => {
		withAccount("me", "git.corp.example");
		const { deps: d, calls } = deps({ "gh auth token": ok(TOKEN) });

		await handlePr("auto-merge", args(), ctx(), d);

		expect(ran(calls, "gh", ["pr", "merge"])?.env).toMatchObject({ GH_ENTERPRISE_TOKEN: TOKEN });
		expect(ran(calls, "gh", ["pr", "merge"])?.env?.GH_TOKEN).toBeUndefined();
	});

	it("skips the token lookup when the project names no account or the caller exported a token", async () => {
		withAccount(null);
		const none = deps();
		await handlePr("create", args({ title: "T" }), ctx(), none.deps);
		expect(ran(none.calls, "gh", ["auth", "token"])).toBeUndefined();
		expect(ran(none.calls, "gh", ["pr", "create"])?.env).toBeUndefined();

		withAccount("work-bot");
		process.env.GH_TOKEN = "caller-token";
		const exported = deps();
		await handlePr("create", args({ title: "T" }), ctx(), exported.deps);
		expect(ran(exported.calls, "gh", ["auth", "token"])).toBeUndefined();
	});

	it("refuses before pushing, exit 23, when gh has no token for that account", async () => {
		withAccount("ghost");
		const { deps: d, calls } = deps({ "gh auth token": fail("no oauth token found for ghost") });

		await expect(handlePr("create", args({ title: "T" }), ctx(), d)).rejects.toThrow("EXIT_23");

		expect(ran(calls, "git", ["push"])).toBeUndefined();
		expect(stderrOutput).toContain("ghost@github.com");
	});
});

describe("dev3 pr create — real git push destination (#2289)", () => {
	let root: string;
	const git = (cwd: string, ...gitArgs: string[]) =>
		execFileSync("git", gitArgs, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dev3-pr-push-"));
		git(root, "init", "-q", "--bare", "-b", "main", "remote.git");
		git(root, "clone", "-q", "remote.git", "wt");
		const wt = join(root, "wt");
		git(wt, "config", "user.email", "t@example.com");
		git(wt, "config", "user.name", "T");
		git(wt, "commit", "-q", "--allow-empty", "-m", "init");
		git(wt, "push", "-q", "origin", "main");
		// A task branch that still tracks the base after a `git branch -m` rename.
		git(wt, "checkout", "-q", "-b", "dev3/task-x", "--track", "origin/main");
		git(wt, "branch", "-m", "dev3/task-x", "fix/example");
		git(wt, "commit", "-q", "--allow-empty", "-m", "work");
		git(wt, "config", "push.default", "upstream");
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("pushes to a same-named remote branch and leaves the base untouched", async () => {
		const wt = join(root, "wt");
		const remote = join(root, "remote.git");
		const baseBefore = git(remote, "rev-parse", "refs/heads/main");
		const { deps: fake } = deps();
		const d: PrDeps = {
			...fake,
			cwd: wt,
			run: (command, runArgs, cwd, env) =>
				command === "git" ? realPrDeps.run(command, runArgs, cwd, env) : fake.run(command, runArgs, cwd, env),
		};

		await handlePr("create", args({ title: "T", base: "main" }), null, d);

		expect(git(remote, "rev-parse", "refs/heads/main")).toBe(baseBefore);
		expect(git(remote, "rev-parse", "refs/heads/fix/example")).toBe(git(wt, "rev-parse", "HEAD"));
		expect(git(wt, "config", "--get", "branch.fix/example.merge")).toBe("refs/heads/fix/example");
	});
});
