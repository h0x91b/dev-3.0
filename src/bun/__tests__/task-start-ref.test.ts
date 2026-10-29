import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../shared/types";
import { OWN_WORKTREE_NOT_A_REPO_ERROR, TASK_REF_UNRESOLVED_PREFIX } from "../../shared/types";

vi.mock("../data", () => ({
	getProject: vi.fn(),
}));

vi.mock("../github", async () => {
	const actual = await vi.importActual<typeof import("../github")>("../github");
	return {
		runGitHub: vi.fn(),
		isNotAGitHubRepoError: actual.isNotAGitHubRepoError,
	};
});

vi.mock("../git", () => ({
	refExists: vi.fn(),
	isGitRepo: vi.fn(async () => true),
	fetchFork: vi.fn(async () => true),
	fetchOrigin: vi.fn(async () => true),
	lastOriginFetchError: vi.fn(() => null),
}));

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import * as data from "../data";
import * as git from "../git";
import * as github from "../github";
import { describePrFailure, repoFromPrUrl, resolvePrUrl, resolveTaskStartRef } from "../task-start-ref";

const PROJECT: Project = {
	id: "proj-1",
	name: "dev-3.0",
	path: "/repo",
	createdAt: new Date(0).toISOString(),
} as Project;

function ghSays(json: unknown) {
	vi.mocked(github.runGitHub).mockResolvedValue({ code: 0, ok: true, stdout: JSON.stringify(json), stderr: "" });
}

function ghFails(stderr: string) {
	vi.mocked(github.runGitHub).mockResolvedValue({ code: 1, ok: false, stdout: "", stderr });
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(data.getProject).mockResolvedValue(PROJECT);
	vi.mocked(git.fetchFork).mockResolvedValue(true);
	vi.mocked(git.fetchOrigin).mockResolvedValue(true);
	vi.mocked(git.refExists).mockResolvedValue(true);
	vi.mocked(git.isGitRepo).mockResolvedValue(true);
	vi.mocked(git.lastOriginFetchError).mockReturnValue(null);
});

describe("resolveTaskStartRef", () => {
	it("resolves --pr to the pull request's own head ref, not to the number it was given", async () => {
		ghSays({ number: 1497, title: "Auto-expand", headRefName: "fix/expand", isCrossRepository: false });

		const ref = await resolveTaskStartRef({ project: PROJECT, pr: "1497" });

		// The whole point of the flag. A pass-through here is the bug this replaces.
		expect(ref).toBe("origin/fix/expand");
		expect(git.fetchOrigin).toHaveBeenCalledWith("/repo", "fix/expand", undefined, { force: true, priority: true });
		expect(git.refExists).toHaveBeenCalledWith("/repo", "refs/remotes/origin/fix/expand");
	});

	it("resolves a fork pull request to the fork remote's ref after fetching it", async () => {
		ghSays({
			number: 1530,
			headRefName: "fix/port-release",
			headRepositoryOwner: { login: "Tyagiquamar" },
			isCrossRepository: true,
		});

		const ref = await resolveTaskStartRef({ project: PROJECT, pr: "1530" });

		expect(ref).toBe("Tyagiquamar/fix/port-release");
		expect(git.fetchFork).toHaveBeenCalledWith("/repo", "Tyagiquamar", "fix/port-release");
	});

	it("accepts a pull-request URL as well as a number", async () => {
		ghSays({ number: 7, headRefName: "feat/x", isCrossRepository: false });

		expect(await resolveTaskStartRef({ project: PROJECT, pr: "https://github.com/h0x91b/dev-3.0/pull/7" }))
			.toBe("origin/feat/x");
	});

	it("returns undefined when neither flag was passed", async () => {
		expect(await resolveTaskStartRef({ project: PROJECT })).toBeUndefined();
		expect(github.runGitHub).not.toHaveBeenCalled();
	});

	it("rejects a pull request that does not exist", async () => {
		ghFails("could not resolve to a PullRequest with the number of 999999");

		await expect(resolveTaskStartRef({ project: PROJECT, pr: "999999" }))
			.rejects.toThrow(/no pull request 999999 in this project/);
	});

	it("rejects a --pr that is neither a number nor a URL before calling gh", async () => {
		await expect(resolveTaskStartRef({ project: PROJECT, pr: "origin/feat/x" }))
			.rejects.toThrow(/--pr takes a pull-request number or URL/);
		expect(github.runGitHub).not.toHaveBeenCalled();
	});

	it("rejects a fork whose branch could not be fetched", async () => {
		ghSays({ number: 3, headRefName: "gone", headRepositoryOwner: { login: "someone" }, isCrossRepository: true });
		vi.mocked(git.fetchFork).mockResolvedValue(false);

		await expect(resolveTaskStartRef({ project: PROJECT, pr: "3" }))
			.rejects.toThrow(/Could not fetch gone from fork someone/);
	});

	it("rejects a same-repo pull request whose branch fetch failed, quoting git", async () => {
		ghSays({ number: 5, headRefName: "feat/x", isCrossRepository: false });
		vi.mocked(git.fetchOrigin).mockResolvedValue(false);
		vi.mocked(git.lastOriginFetchError).mockReturnValue("ERROR: Repository not found.\nfatal: Could not read from remote repository.");

		const rejection = resolveTaskStartRef({ project: PROJECT, pr: "5" });
		await expect(rejection).rejects.toThrow(new RegExp(TASK_REF_UNRESOLVED_PREFIX));
		await expect(rejection).rejects.toThrow(/could not fetch the pull request's branch \(git fetch origin feat\/x failed: ERROR: Repository not found\. fatal/);
		await expect(rejection).rejects.not.toThrow(/no pull request|fork|gh auth login/);
	});

		it("rejects --pr and --branch together", async () => {
		await expect(resolveTaskStartRef({ project: PROJECT, pr: "1", branch: "origin/x" }))
			.rejects.toThrow(/pass one of them/);
	});

	it("tags every rejection so the CLI can give it its own exit code", async () => {
		ghFails("no such pull request");

		await expect(resolveTaskStartRef({ project: PROJECT, pr: "1" }))
			.rejects.toThrow(new RegExp(TASK_REF_UNRESOLVED_PREFIX));
	});

	it("rejects --pr on a board with no git repository", async () => {
		await expect(resolveTaskStartRef({ project: { ...PROJECT, kind: "virtual" } as Project, pr: "1" }))
			.rejects.toThrow(/no git workflow/);
	});

	it("rejects --pr and --branch on a project with the git workflow off", async () => {
		const gitless = { ...PROJECT, gitWorkflow: false } as Project;
		await expect(resolveTaskStartRef({ project: gitless, pr: "1" })).rejects.toThrow(/no git workflow/);
		await expect(resolveTaskStartRef({ project: gitless, branch: "origin/feat/x" })).rejects.toThrow(/no git workflow/);
		expect(git.refExists).not.toHaveBeenCalled();
	});

	describe("--branch", () => {
		it("returns a remote-tracking ref that exists", async () => {
			vi.mocked(git.refExists).mockImplementation(async (_p, ref) => ref === "refs/remotes/origin/feat/x");

			expect(await resolveTaskStartRef({ project: PROJECT, branch: "origin/feat/x" })).toBe("origin/feat/x");
		});

		it("returns a local branch that exists", async () => {
			vi.mocked(git.refExists).mockImplementation(async (_p, ref) => ref === "refs/heads/my-work");

			expect(await resolveTaskStartRef({ project: PROJECT, branch: "my-work" })).toBe("my-work");
		});

		it("rejects a ref that is not in the repo", async () => {
			vi.mocked(git.refExists).mockResolvedValue(false);

			await expect(resolveTaskStartRef({ project: PROJECT, branch: "origin/typo" }))
				.rejects.toThrow(/no ref "origin\/typo" in \/repo/);
		});

		it("does not tell an Operations board to pass --worktree it already passed", async () => {
			const ops = { ...PROJECT, kind: "virtual" } as Project;

			for (const ownWorktree of [true, false]) {
				const err = await resolveTaskStartRef({ project: ops, branch: "x", ownWorktree }).catch((e: Error) => e);
				expect(String(err)).toMatch(/Operations board/);
				expect(String(err)).not.toMatch(/Pass --worktree/);
			}
		});

		it("names a gitless folder that is not a repository before looking up the ref", async () => {
			const gitless = { ...PROJECT, gitWorkflow: false } as Project;
			vi.mocked(git.isGitRepo).mockResolvedValue(false);
			vi.mocked(git.refExists).mockResolvedValue(false);

			await expect(resolveTaskStartRef({ project: gitless, branch: "x", ownWorktree: true }))
				.rejects.toThrow(OWN_WORKTREE_NOT_A_REPO_ERROR);
			expect(git.refExists).not.toHaveBeenCalled();
		});

		// A tag or a bare sha would resolve under neither refs/remotes nor refs/heads,
		// so the check must not be satisfied by `git rev-parse <anything>`.
		it("does not accept a ref that only resolves outside heads and remotes", async () => {
			vi.mocked(git.refExists).mockImplementation(async (_p, ref) => ref === "v1.2.3");

			await expect(resolveTaskStartRef({ project: PROJECT, branch: "v1.2.3" })).rejects.toThrow();
		});
	});
});

describe("describePrFailure", () => {
	it("names a missing gh binary and offers the way round it", () => {
		expect(describePrFailure("42", "Error: spawn ENOENT gh"))
			.toContain("`gh`) is not installed");
	});

	it("names an unauthenticated gh", () => {
		expect(describePrFailure("42", "gh: To get started with GitHub CLI, please run: gh auth login"))
			.toContain("gh auth login");
	});

	it("names a project with no GitHub remote", () => {
		expect(describePrFailure("42", "none of the git remotes configured for this repository point to a known GitHub host"))
			.toContain("no GitHub remote");
	});

	it("falls back to naming the pull request and quoting gh", () => {
		const message = describePrFailure("42", "GraphQL: Could not resolve to a PullRequest");
		expect(message).toContain("no pull request 42");
		expect(message).toContain("Could not resolve to a PullRequest");
	});
});

describe("resolvePrUrl failure reasons", () => {
	const ok = (stdout: string) => ({ code: 0, ok: true, stdout, stderr: "" });
	const fail = (stderr: string) => ({ code: 1, ok: false, stdout: "", stderr });

	it("names both repositories when the link points at another one", async () => {
		vi.mocked(github.runGitHub)
			.mockResolvedValueOnce(fail("GraphQL: Could not resolve to a Repository with the name 'o/r'."))
			.mockResolvedValueOnce(ok("h0x91b/dev-3.0\n"));

		const result = await resolvePrUrl({ projectId: "proj-1", url: "https://github.com/o/r/pull/42" });

		expect(result).toMatchObject({ ok: false, reason: "foreign-repo", prRepo: "o/r", projectRepo: "h0x91b/dev-3.0" });
	});

	it("blames a missing GitHub remote for a fork fetch that went nowhere", async () => {
		vi.mocked(github.runGitHub)
			.mockResolvedValueOnce(ok(JSON.stringify({ number: 9, headRefName: "x", headRepositoryOwner: { login: "f" }, isCrossRepository: true })))
			.mockResolvedValueOnce(fail("none of the git remotes configured for this repository point to a known GitHub host"));
		vi.mocked(git.fetchFork).mockResolvedValue(false);

		const result = await resolvePrUrl({ projectId: "proj-1", url: "https://github.com/h0x91b/dev-3.0/pull/9" });

		expect(result).toMatchObject({ ok: false, reason: "no-github-remote", projectRepo: null });
	});

	it("keeps not-found for a missing pull request in the project's own repo", async () => {
		vi.mocked(github.runGitHub)
			.mockResolvedValueOnce(fail("GraphQL: Could not resolve to a PullRequest with the number of 999999."))
			.mockResolvedValueOnce(ok("H0X91B/Dev-3.0"));

		const result = await resolvePrUrl({ projectId: "proj-1", url: "https://github.com/h0x91b/dev-3.0/pull/999999" });

		expect(result.reason).toBe("not-found");
	});

	it("does not ask gh about the repo when gh itself is unusable", async () => {
		vi.mocked(github.runGitHub).mockResolvedValueOnce(fail("gh: To get started with GitHub CLI, please run: gh auth login"));

		const result = await resolvePrUrl({ projectId: "proj-1", url: "https://github.com/o/r/pull/1" });

		expect(result.reason).toBe("gh-auth");
		expect(github.runGitHub).toHaveBeenCalledTimes(1);
	});

	describe("same-repo branch fetch", () => {
		const URL = "https://github.com/acme/widgets/pull/12";
		const prJson = JSON.stringify({ number: 12, title: "T", headRefName: "feat/y", isCrossRepository: false });

		it("fails when the fetch fails and no ref was ever cached", async () => {
			vi.mocked(github.runGitHub).mockResolvedValueOnce(ok(prJson));
			vi.mocked(git.fetchOrigin).mockResolvedValue(false);
			vi.mocked(git.refExists).mockResolvedValue(false);
			vi.mocked(git.lastOriginFetchError).mockReturnValue("fatal: could not read Username: terminal prompts disabled");

			const result = await resolvePrUrl({ projectId: "proj-1", url: URL });

			// Not gh-auth even though git's text mentions credentials: the reason is set, not guessed.
			expect(result).toMatchObject({ ok: false, branch: null, number: 12, isFork: false, reason: "origin-fetch" });
			expect(result.error).toBe("git fetch origin feat/y failed: fatal: could not read Username: terminal prompts disabled");
			expect(github.runGitHub).toHaveBeenCalledTimes(1);
		});

		it("fails when the fetch fails even though a stale origin ref is cached", async () => {
			vi.mocked(github.runGitHub).mockResolvedValueOnce(ok(prJson));
			vi.mocked(git.fetchOrigin).mockResolvedValue(false);
			vi.mocked(git.refExists).mockResolvedValue(true);
			vi.mocked(git.lastOriginFetchError).mockReturnValue("ERROR: Repository not found.");

			const result = await resolvePrUrl({ projectId: "proj-1", url: URL });

			expect(result).toMatchObject({ ok: false, branch: null, reason: "origin-fetch" });
			expect(git.refExists).not.toHaveBeenCalled();
		});

		it("still fails without git's text, and caps a long one", async () => {
			vi.mocked(github.runGitHub).mockResolvedValueOnce(ok(prJson));
			vi.mocked(git.fetchOrigin).mockResolvedValue(false);
			expect((await resolvePrUrl({ projectId: "proj-1", url: URL })).error).toBe("git fetch origin feat/y failed");

			vi.mocked(github.runGitHub).mockResolvedValueOnce(ok(prJson));
			vi.mocked(git.lastOriginFetchError).mockReturnValue("x".repeat(1000));
			expect((await resolvePrUrl({ projectId: "proj-1", url: URL })).error!.length).toBeLessThan(400);
		});

		it("fails when the fetch reports success but origin/<head> is absent", async () => {
			vi.mocked(github.runGitHub).mockResolvedValueOnce(ok(prJson));
			vi.mocked(git.refExists).mockResolvedValue(false);

			const result = await resolvePrUrl({ projectId: "proj-1", url: URL });

			expect(result).toMatchObject({ ok: false, reason: "origin-fetch" });
			expect(result.error).toContain("origin/feat/y is still missing");
		});

		it("resolves to origin/<head> when the fetch succeeds and the ref exists", async () => {
			vi.mocked(github.runGitHub).mockResolvedValueOnce(ok(prJson));

			const result = await resolvePrUrl({ projectId: "proj-1", url: URL });

			expect(result).toEqual({ ok: true, branch: "origin/feat/y", number: 12, title: "T", isFork: false, error: null });
		});

		it("leaves the fork path on fetchFork alone", async () => {
			vi.mocked(github.runGitHub).mockResolvedValueOnce(ok(JSON.stringify({ number: 3, headRefName: "z", headRepositoryOwner: { login: "f" }, isCrossRepository: true })));

			const result = await resolvePrUrl({ projectId: "proj-1", url: URL });

			expect(result).toMatchObject({ ok: true, branch: "f/z", isFork: true });
			expect(git.fetchOrigin).not.toHaveBeenCalled();
			expect(git.refExists).not.toHaveBeenCalled();
		});
	});

	it("reads owner/repo only from a pull-request URL", () => {
		expect(repoFromPrUrl("https://github.com/h0x91b/dev-3.0/pull/7/files")).toBe("h0x91b/dev-3.0");
		expect(repoFromPrUrl("1497")).toBeNull();
	});
});
