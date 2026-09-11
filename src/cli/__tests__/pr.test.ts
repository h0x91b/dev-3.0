import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handlePr, type PrCommandResult, type PrDeps } from "../commands/pr";
import type { ParsedArgs } from "../args";
import type { CliContext } from "../context";

vi.mock("../context", () => ({
	readTaskDirect: vi.fn(() => null),
}));

import { readTaskDirect } from "../context";
const mockReadTask = vi.mocked(readTaskDirect);

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

interface Call {
	command: string;
	args: string[];
	cwd: string;
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
		run: (command, runArgs, cwd) => {
			calls.push({ command, args: runArgs, cwd });
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
		const { deps: d, calls } = deps({ "gh auth status": fail("You are not logged into any GitHub hosts") });

		await expect(handlePr("create", args({ title: "T" }), null, d)).rejects.toThrow("EXIT_23");

		expect(ran(calls, "git", ["push"])).toBeUndefined();
		expect(ran(calls, "gh", ["pr", "create"])).toBeUndefined();
		expect(stderrOutput).toContain("not authenticated");
	});

	it("checks auth before touching git at all", async () => {
		const { deps: d, calls } = deps({ "gh auth status": fail("logged out") });

		await expect(handlePr("create", args({ title: "T" }), null, d)).rejects.toThrow("EXIT_23");

		expect(calls.every((c) => c.command === "gh")).toBe(true);
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
