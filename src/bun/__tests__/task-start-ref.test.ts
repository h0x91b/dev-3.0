import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../shared/types";
import { TASK_REF_UNRESOLVED_PREFIX } from "../../shared/types";

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
	fetchFork: vi.fn(async () => true),
	fetchOrigin: vi.fn(async () => true),
}));

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import * as data from "../data";
import * as git from "../git";
import * as github from "../github";
import { describePrFailure, resolveTaskStartRef } from "../task-start-ref";

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
});

describe("resolveTaskStartRef", () => {
	it("resolves --pr to the pull request's own head ref, not to the number it was given", async () => {
		ghSays({ number: 1497, title: "Auto-expand", headRefName: "fix/expand", isCrossRepository: false });

		const ref = await resolveTaskStartRef({ project: PROJECT, pr: "1497" });

		// The whole point of the flag. A pass-through here is the bug this replaces.
		expect(ref).toBe("origin/fix/expand");
		expect(git.fetchOrigin).toHaveBeenCalledWith("/repo", "fix/expand");
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
			.rejects.toThrow(/no git repository/);
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
