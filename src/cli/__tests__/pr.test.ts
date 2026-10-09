import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handlePr, type PrCommandResult, type PrDeps } from "../commands/pr";
import type { ParsedArgs } from "../args";
import type { CliContext } from "../context";

vi.mock("../context", () => ({
	readTaskDirect: vi.fn(() => null),
	readProjectDirect: vi.fn(() => null),
}));

import { readProjectDirect, readTaskDirect } from "../context";
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

describe("dev3 pr create — happy path", () => {
	it("pushes the branch, opens the pull request, and prints its URL", async () => {
		const { deps: d, calls } = deps();

		await handlePr("create", args({ title: "Add a thing", description: "Why it exists" }), null, d);

		expect(ran(calls, "git", ["push", "--set-upstream", "origin", "feat/thing"])).toBeDefined();
		const create = ran(calls, "gh", ["pr", "create"])!;
		expect(create.args).toContain("Add a thing");
		expect(create.args).toContain("Why it exists");
		expect(create.cwd).toBe(CWD);
		expect(stdoutOutput).toContain("feat/thing → origin");
		expect(stdoutOutput).toContain(PR_URL);
	});

	it("finds the URL even when gh prints chatter around it", async () => {
		const { deps: d } = deps({
			"gh pr create": ok(`Creating pull request for feat/thing into main\n\n${PR_URL}\n`),
		});

		await handlePr("create", args({ title: "T" }), null, d);

		expect(stdoutOutput).toContain(PR_URL);
	});

	it("runs in the task's worktree, not the process cwd", async () => {
		const { deps: d, calls } = deps({}, { cwd: "/somewhere/else" });

		await handlePr("create", args({ title: "T" }), ctx({ worktreePath: "/wt" }), d);

		expect(ran(calls, "git", ["push"])!.cwd).toBe("/wt");
	});

	it("passes --draft through", async () => {
		const { deps: d, calls } = deps();

		await handlePr("create", args({ title: "T", draft: "true" }), null, d);

		expect(ran(calls, "gh", ["pr", "create"])!.args).toContain("--draft");
	});
});

describe("dev3 pr create — gh must be installed and logged in", () => {
	it("exits 23 and pushes nothing when gh is absent", async () => {
		const { deps: d, calls } = deps({ "gh --version": { status: null, stdout: "", stderr: "ENOENT" } });

		await expect(handlePr("create", args({ title: "T" }), null, d)).rejects.toThrow("EXIT_23");

		expect(ran(calls, "git", ["push"])).toBeUndefined();
		expect(stderrOutput).toContain("gh auth login");
	});

	it("exits 23 and pushes nothing when gh is not authenticated", async () => {
		const { deps: d, calls } = deps({ "gh auth status": fail("You are not logged into any GitHub hosts"), "gh api user": fail(LOGGED_OUT_PROBE) });

		await expect(handlePr("create", args({ title: "T" }), null, d)).rejects.toThrow("EXIT_23");

		expect(ran(calls, "git", ["push"])).toBeUndefined();
		expect(ran(calls, "gh", ["pr", "create"])).toBeUndefined();
		expect(stderrOutput).toContain("not authenticated");
	});

	it("checks auth before touching git at all", async () => {
		const { deps: d, calls } = deps({ "gh auth status": fail("logged out"), "gh api user": fail(LOGGED_OUT_PROBE) });

		await expect(handlePr("create", args({ title: "T" }), null, d)).rejects.toThrow("EXIT_23");

		expect(calls.every((c) => c.command === "gh")).toBe(true);
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

	it("omits the footer outside a task worktree", async () => {
		const { deps: d, calls } = deps();

		await handlePr("create", args({ title: "T", description: "Body" }), null, d);

		expect(bodyOf(calls)).toBe("Body");
	});

	it("omits the footer when the user turned it off", async () => {
		const { deps: d, calls } = deps({}, { originTaskLinkEnabled: () => false });

		await handlePr("create", args({ title: "T", description: "Body" }), ctx(), d);

		expect(bodyOf(calls)).toBe("Body");
	});

	// A dev3:// link is dead anywhere the scheme is not registered, and a PR body
	// is public — so the host decides before the preference does.
	it("omits the footer where no dev3:// handler exists", async () => {
		const { deps: d, calls } = deps({}, { platform: "linux" });

		await handlePr("create", args({ title: "T", description: "Body" }), ctx(), d);

		expect(bodyOf(calls)).toBe("Body");
	});

	it("sends an empty body when --description is absent", async () => {
		const { deps: d, calls } = deps();

		await handlePr("create", args({ title: "T" }), null, d);

		expect(bodyOf(calls)).toBe("");
	});
});

describe("dev3 pr create — the base branch", () => {
	it("defaults to the base branch the task was created from", async () => {
		mockReadTask.mockReturnValue({ baseBranch: "develop" });
		const { deps: d, calls } = deps();

		await handlePr("create", args({ title: "T" }), ctx(), d);

		const create = ran(calls, "gh", ["pr", "create"])!;
		expect(create.args[create.args.indexOf("--base") + 1]).toBe("develop");
		expect(stdoutOutput).toContain("develop");
	});

	it("lets --base win over the task's base branch", async () => {
		mockReadTask.mockReturnValue({ baseBranch: "develop" });
		const { deps: d, calls } = deps();

		await handlePr("create", args({ title: "T", base: "release/9" }), ctx(), d);

		const create = ran(calls, "gh", ["pr", "create"])!;
		expect(create.args[create.args.indexOf("--base") + 1]).toBe("release/9");
	});

	it("omits --base entirely with no task context and no flag", async () => {
		const { deps: d, calls } = deps();

		await handlePr("create", args({ title: "T" }), null, d);

		expect(ran(calls, "gh", ["pr", "create"])!.args).not.toContain("--base");
	});

	it("refuses when the checked-out branch IS the base branch", async () => {
		mockReadTask.mockReturnValue({ baseBranch: "main" });
		const { deps: d, calls } = deps({ "git rev-parse": ok("main\n") });

		await expect(handlePr("create", args({ title: "T" }), ctx(), d)).rejects.toThrow("EXIT_1");

		expect(ran(calls, "git", ["push"])).toBeUndefined();
		expect(stderrOutput).toContain("base branch");
	});
});

describe("dev3 pr create — auto-merge", () => {
	it("squashes by default", async () => {
		const { deps: d, calls } = deps();

		await handlePr("create", args({ title: "T", "auto-merge": "true" }), null, d);

		const merge = ran(calls, "gh", ["pr", "merge"])!;
		expect(merge.args).toEqual(["pr", "merge", "--auto", "--squash", PR_URL]);
		expect(stdoutOutput).toContain("Auto-merge   enabled (squash)");
	});

	it("accepts a named strategy", async () => {
		const { deps: d, calls } = deps();

		await handlePr("create", args({ title: "T", "auto-merge": "rebase" }), null, d);

		expect(ran(calls, "gh", ["pr", "merge"])!.args).toContain("--rebase");
	});

	it("rejects a strategy gh does not have", async () => {
		const { deps: d, calls } = deps();

		await expect(handlePr("create", args({ title: "T", "auto-merge": "fastforward" }), null, d)).rejects.toThrow("EXIT_3");

		expect(calls).toEqual([]);
	});

	it("never enables auto-merge unless asked", async () => {
		const { deps: d, calls } = deps();

		await handlePr("create", args({ title: "T" }), null, d);

		expect(ran(calls, "gh", ["pr", "merge"])).toBeUndefined();
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
	it("squashes the current branch's pull request by default", async () => {
		const { deps: d, calls } = deps();

		await handlePr("auto-merge", args(), null, d);

		expect(ran(calls, "gh", ["pr", "merge"])!.args).toEqual(["pr", "merge", "--auto", "--squash"]);
		expect(stdoutOutput).toContain("Auto-merge   enabled (squash)");
	});

	it("accepts a strategy and an explicit pull request", async () => {
		const { deps: d, calls } = deps();

		await handlePr("auto-merge", { positional: ["1722"], flags: { strategy: "rebase" } }, null, d);

		expect(ran(calls, "gh", ["pr", "merge"])!.args).toEqual(["pr", "merge", "--auto", "--rebase", "1722"]);
		expect(stdoutOutput).toContain("on 1722");
	});

	it("clears auto-merge with --off", async () => {
		const { deps: d, calls } = deps();

		await handlePr("auto-merge", args({ off: "true" }), null, d);

		expect(ran(calls, "gh", ["pr", "merge"])!.args).toEqual(["pr", "merge", "--disable-auto"]);
		expect(stdoutOutput).toContain("cleared");
	});

	it("runs in the task's worktree", async () => {
		const { deps: d, calls } = deps({}, { cwd: "/somewhere/else" });

		await handlePr("auto-merge", args(), ctx({ worktreePath: "/wt" }), d);

		expect(ran(calls, "gh", ["pr", "merge"])!.cwd).toBe("/wt");
	});

	it("needs an authenticated gh too", async () => {
		const { deps: d, calls } = deps({ "gh auth status": fail("logged out"), "gh api user": fail(LOGGED_OUT_PROBE) });

		await expect(handlePr("auto-merge", args(), null, d)).rejects.toThrow("EXIT_23");

		expect(ran(calls, "gh", ["pr", "merge"])).toBeUndefined();
	});

	it("rejects --off together with --strategy", async () => {
		const { deps: d, calls } = deps();

		await expect(handlePr("auto-merge", args({ off: "true", strategy: "squash" }), null, d)).rejects.toThrow("EXIT_3");

		expect(calls).toEqual([]);
	});

	it("rejects a strategy gh does not have", async () => {
		const { deps: d } = deps();
		await expect(handlePr("auto-merge", args({ strategy: "fastforward" }), null, d)).rejects.toThrow("EXIT_3");
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

	it("never touches git — the pull request already exists", async () => {
		const { deps: d, calls } = deps();

		await handlePr("auto-merge", args(), null, d);

		expect(calls.every((c) => c.command === "gh")).toBe(true);
	});
});

describe("dev3 pr create — refusals", () => {
	it("requires --title", async () => {
		const { deps: d, calls } = deps();

		await expect(handlePr("create", args({ description: "b" }), null, d)).rejects.toThrow("EXIT_3");
		expect(calls).toEqual([]);
	});

	it("rejects a blank --title", async () => {
		const { deps: d } = deps();
		await expect(handlePr("create", args({ title: "   " }), null, d)).rejects.toThrow("EXIT_3");
	});

	it("rejects unknown flags", async () => {
		const { deps: d } = deps();
		await expect(handlePr("create", args({ title: "T", bogus: "1" }), null, d)).rejects.toThrow("EXIT_3");
	});

	// Same value-eating trap as `--off`: a switch that got a value was mistyped.
	it("refuses --draft with a value", async () => {
		const { deps: d, calls } = deps();

		await expect(handlePr("create", args({ title: "T", draft: "yes" }), null, d)).rejects.toThrow("EXIT_3");

		expect(calls).toEqual([]);
	});

	it("refuses --description with no value", async () => {
		const { deps: d, calls } = deps();

		await expect(handlePr("create", args({ title: "T", description: "true" }), null, d)).rejects.toThrow("EXIT_3");

		expect(calls).toEqual([]);
		expect(stderrOutput).toContain("--description needs a value");
	});

	it("rejects an unknown subcommand", async () => {
		const { deps: d } = deps();
		await expect(handlePr("list", args({}), null, d)).rejects.toThrow("EXIT_3");
	});

	it("rejects a missing subcommand", async () => {
		const { deps: d } = deps();
		await expect(handlePr(undefined, args({ title: "T" }), null, d)).rejects.toThrow("EXIT_3");
	});

	it("refuses on a detached HEAD", async () => {
		const { deps: d, calls } = deps({ "git rev-parse": ok("HEAD\n") });

		await expect(handlePr("create", args({ title: "T" }), null, d)).rejects.toThrow("EXIT_1");

		expect(ran(calls, "git", ["push"])).toBeUndefined();
		expect(stderrOutput).toContain("detached");
	});

	it("reports a git failure outside a repository", async () => {
		const { deps: d } = deps({ "git rev-parse": fail("fatal: not a git repository") });

		await expect(handlePr("create", args({ title: "T" }), null, d)).rejects.toThrow("EXIT_1");

		expect(stderrOutput).toContain("not a git repository");
	});

	it("stops before gh when the push fails", async () => {
		const { deps: d, calls } = deps({ "git push": fail("! [rejected] non-fast-forward") });

		await expect(handlePr("create", args({ title: "T" }), null, d)).rejects.toThrow("EXIT_1");

		expect(ran(calls, "gh", ["pr", "create"])).toBeUndefined();
		expect(stderrOutput).toContain("non-fast-forward");
	});

	it("surfaces what gh said when creation fails", async () => {
		const { deps: d } = deps({ "gh pr create": fail("a pull request for branch feat/thing already exists") });

		await expect(handlePr("create", args({ title: "T" }), null, d)).rejects.toThrow("EXIT_1");

		expect(stderrOutput).toContain("already exists");
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

	it("leaves the active account alone when the project names none", async () => {
		withAccount(null);
		const { deps: d, calls } = deps();

		await handlePr("create", args({ title: "T" }), ctx(), d);

		expect(ran(calls, "gh", ["auth", "token"])).toBeUndefined();
		expect(ran(calls, "gh", ["pr", "create"])?.env).toBeUndefined();
	});

	it("lets a token the caller exported win over the project setting", async () => {
		withAccount("work-bot");
		process.env.GH_TOKEN = "caller-token";
		const { deps: d, calls } = deps();

		await handlePr("create", args({ title: "T" }), ctx(), d);

		expect(ran(calls, "gh", ["auth", "token"])).toBeUndefined();
	});

	it("refuses before pushing, exit 23, when gh has no token for that account", async () => {
		withAccount("ghost");
		const { deps: d, calls } = deps({ "gh auth token": fail("no oauth token found for ghost") });

		await expect(handlePr("create", args({ title: "T" }), ctx(), d)).rejects.toThrow("EXIT_23");

		expect(ran(calls, "git", ["push"])).toBeUndefined();
		expect(stderrOutput).toContain("ghost@github.com");
	});
});
