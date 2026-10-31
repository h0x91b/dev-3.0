import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const account = { host: "github.com", login: "reader", active: true };
const query = vi.fn();
const run = vi.fn();
vi.mock("../github", () => ({
	queryGitHub: (...args: unknown[]) => query(...args),
	GitHubGraphQLError: class extends Error {
		constructor(message: string, readonly errors: { type?: string; path?: (string | number)[] }[] = [], readonly data?: unknown) { super(message); }
	},
	runGitHub: (...args: unknown[]) => run(...args),
	resolveGitHubAccount: vi.fn(async (project) => ({ ...account, host: project.githubAuthHost ?? account.host, login: project.githubAuthLogin ?? account.login })),
	isNotAGitHubRepoError: (result: { stderr: string }) => result.stderr.includes("no git remotes"),
}));

const page = <T>(nodes: T[], endCursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage: !!endCursor, endCursor } });
function pr(overrides: Record<string, unknown> = {}) {
	return {
		number: 42, url: "https://github.com/owner/repo/pull/42", title: "Change", state: "OPEN",
		headRefName: "feat/work", headRefOid: "head", isDraft: false, autoMergeRequest: null,
		mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", author: { login: "author" },
		commits: { nodes: [{ commit: { oid: "head", statusCheckRollup: { contexts: page([{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }]) } } }] },
		reviewThreads: page([{ isResolved: false }, { isResolved: true }]), ...overrides,
	};
}
const payload = (value = pr()) => ({ repository: { open: { nodes: [value] }, known: value } });

beforeEach(() => {
	vi.resetModules();
	query.mockReset().mockResolvedValue(payload());
	run.mockReset().mockResolvedValue({ ok: true, stdout: JSON.stringify({ nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" }) });
});
afterEach(() => vi.useRealTimers());

describe("shared GraphQL PR reads", () => {
	it("uses one query for PR, CI, and unresolved-thread status", async () => {
		const { readTaskPullRequest } = await import("../github-pr-status");
		const result = await readTaskPullRequest({}, "/repo", "feat/work", 42);
		expect(query).toHaveBeenCalledTimes(1);
		expect(query).toHaveBeenCalledWith(account, expect.stringContaining("reviewThreads"), expect.objectContaining({ branch: "feat/work", number: 42, byBranch: true, known: true }), expect.any(AbortSignal));
		expect(result?.pr).toMatchObject({ number: 42, state: "OPEN", unresolvedCount: 1, statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }] });
	});

	it("shares both in-flight and recent reads across worktrees, and number snapshots", async () => {
		const { readTaskPullRequest } = await import("../github-pr-status");
		await Promise.all(Array.from({ length: 10 }, () => readTaskPullRequest({}, "/repo", "feat/work", 42)));
		await readTaskPullRequest({}, "/other-worktree", "feat/work", 42);
		await readTaskPullRequest({}, "/repo", "", 42);
		expect(query).toHaveBeenCalledTimes(1);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it.each(["MERGED", "CLOSED"])("expires OPEN after a minute and reports %s, without waiting for restart", async (state) => {
		vi.useFakeTimers(); vi.setSystemTime(0);
		const { readTaskPullRequest } = await import("../github-pr-status");
		await readTaskPullRequest({}, "/repo", "feat/work", 42);
		query.mockResolvedValue({ repository: { open: { nodes: [] }, known: pr({ state }) } });
		vi.setSystemTime(59_999);
		expect((await readTaskPullRequest({}, "/repo", "feat/work", 42))?.pr?.state).toBe("OPEN");
		vi.setSystemTime(60_000);
		expect((await readTaskPullRequest({}, "/repo", "feat/work", 42))?.pr?.state).toBe(state);
		expect(query).toHaveBeenCalledTimes(2);
	});

	it("refreshes a merged PR's CI too, because checks can still finish after merge", async () => {
		vi.useFakeTimers(); vi.setSystemTime(0);
		const { readTaskPullRequest } = await import("../github-pr-status");
		query.mockResolvedValue({ repository: { known: pr({ state: "MERGED", commits: { nodes: [] } }) } });
		await readTaskPullRequest({}, "/repo", "", 42);
		query.mockResolvedValue({ repository: { known: pr({ state: "MERGED" }) } });
		vi.setSystemTime(60_000);
		expect((await readTaskPullRequest({}, "/repo", "", 42))?.pr?.statusCheckRollup).toHaveLength(1);
	});

	it("manual refresh bypasses a completed cache and joins a simultaneous refresh", async () => {
		const { readTaskPullRequest } = await import("../github-pr-status");
		await readTaskPullRequest({}, "/repo", "feat/work", 42);
		query.mockResolvedValue(payload(pr({ state: "CLOSED" })));
		const results = await Promise.all(Array.from({ length: 5 }, () => readTaskPullRequest({}, "/repo", "feat/work", 42, { force: true })));
		expect(results.every((result) => result?.pr?.state === "CLOSED")).toBe(true);
		expect(query).toHaveBeenCalledTimes(2);
	});

	it("keeps a branch's \"no PR\" for a minute, and only a forced read sees a PR opened since", async () => {
		const { readTaskPullRequest } = await import("../github-pr-status");
		query.mockResolvedValue({ repository: { open: { nodes: [] }, known: null } });
		expect((await readTaskPullRequest({}, "/repo", "feat/work"))?.pr).toBeNull();
		query.mockResolvedValue(payload());
		expect((await readTaskPullRequest({}, "/repo", "feat/work"))?.pr).toBeNull();
		expect((await readTaskPullRequest({}, "/repo", "feat/work", null, { force: true }))?.pr?.number).toBe(42);
		expect(query).toHaveBeenCalledTimes(2);
	});

	it("prefers a new open PR over the saved merged PR", async () => {
		const { readTaskPullRequest } = await import("../github-pr-status");
		query.mockResolvedValue({ repository: { open: { nodes: [pr({ number: 43 })] }, known: pr({ state: "MERGED" }) } });
		expect((await readTaskPullRequest({}, "/repo", "feat/work", 42))?.pr?.number).toBe(43);
	});

	it("never returns a follow-up PR as the snapshot of a saved PR number", async () => {
		const { readTaskPullRequest } = await import("../github-pr-status");
		query.mockResolvedValueOnce({ repository: { open: { nodes: [pr({ number: 43 })] }, known: pr({ state: "MERGED" }) } });
		expect((await readTaskPullRequest({}, "/repo", "feat/work", 42))?.pr?.number).toBe(43);
		query.mockResolvedValueOnce({ repository: { known: pr({ state: "MERGED" }) } });
		expect((await readTaskPullRequest({}, "/repo", "", 42))?.pr).toMatchObject({ number: 42, state: "MERGED" });
	});

	it("keeps saved PR history after a branch change or deletion", async () => {
		const { readTaskPullRequest } = await import("../github-pr-status");
		query.mockResolvedValue({ repository: { open: { nodes: [] }, known: pr({ state: "MERGED", headRefName: "old/branch" }) } });
		expect((await readTaskPullRequest({}, "/repo", "follow-up", 42))?.pr).toMatchObject({ state: "MERGED", headRefName: "old/branch" });
	});

	it("never reuses data across GitHub accounts or hosts", async () => {
		const { readTaskPullRequest } = await import("../github-pr-status");
		await readTaskPullRequest({}, "/repo", "feat/work", 42);
		await readTaskPullRequest({ githubAuthLogin: "other" }, "/repo", "feat/work", 42);
		run.mockResolvedValue({ ok: true, stdout: JSON.stringify({ nameWithOwner: "owner/repo", url: "https://enterprise.example/owner/repo" }) });
		await readTaskPullRequest({ githubAuthHost: "enterprise.example" }, "/repo", "feat/work", 42);
		expect(query).toHaveBeenCalledTimes(3);
		expect(query.mock.calls[2][0].host).toBe("enterprise.example");
	});

	it("does not send credentials to a repository on another host", async () => {
		const { readTaskPullRequest } = await import("../github-pr-status");
		expect(await readTaskPullRequest({ githubAuthHost: "enterprise.example" }, "/repo", "feat/work", 42)).toBeNull();
		expect(query).not.toHaveBeenCalled();
	});

	it("distinguishes a non-GitHub remote from an unavailable API", async () => {
		const { readTaskPullRequest } = await import("../github-pr-status");
		run.mockResolvedValue({ ok: false, stderr: "no git remotes found" });
		expect(await readTaskPullRequest({}, "/non-github", "feat/work")).toEqual({ pr: null, isGitHub: false, checkedAt: expect.any(Number) });
		query.mockRejectedValue(new Error("offline"));
		run.mockResolvedValue({ ok: true, stdout: JSON.stringify({ nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" }) });
		expect(await readTaskPullRequest({}, "/repo", "feat/work", 42)).toBeNull();
		expect(await readTaskPullRequest({}, "/repo", "feat/work", 42)).toBeNull();
		expect(query).toHaveBeenCalledTimes(2);
	});

	it("distinguishes no open PR from an unavailable saved PR", async () => {
		const { readTaskPullRequest } = await import("../github-pr-status");
		query.mockResolvedValue({ repository: { open: { nodes: [] }, known: null } });
		expect(await readTaskPullRequest({}, "/repo", "feat/work")).toEqual({ pr: null, isGitHub: true, checkedAt: expect.any(Number) });
		expect(await readTaskPullRequest({}, "/repo", "feat/work", 42)).toBeNull();
	});

	it("retries a failed read on the next poll instead of caching its rejection", async () => {
		const { readTaskPullRequest } = await import("../github-pr-status");
		query.mockRejectedValueOnce(new Error("temporary outage"));
		expect(await readTaskPullRequest({}, "/repo", "feat/work", 42)).toBeNull();
		expect((await readTaskPullRequest({}, "/repo", "feat/work", 42))?.pr?.number).toBe(42);
		expect(query).toHaveBeenCalledTimes(2);
	});

	it("retains branch discovery when only the saved PR number is not found", async () => {
		const { readTaskPullRequest } = await import("../github-pr-status");
		const { GitHubGraphQLError } = await import("../github");
		query.mockRejectedValue(new GitHubGraphQLError("No such PR", [{ type: "NOT_FOUND", path: ["repository", "known"] }], { repository: { open: { nodes: [pr()] }, known: null } }));
		expect((await readTaskPullRequest({}, "/repo", "feat/work", 999))?.pr?.number).toBe(42);
		expect(query).toHaveBeenCalledTimes(1);
	});

	it("does not accept partial branch data with unrelated GraphQL errors", async () => {
		const { readTaskPullRequest } = await import("../github-pr-status");
		const { GitHubGraphQLError } = await import("../github");
		query.mockRejectedValue(new GitHubGraphQLError("Cannot read branch PRs", [{ type: "FORBIDDEN", path: ["repository", "open"] }], payload()));
		expect(await readTaskPullRequest({}, "/repo", "feat/work", 999)).toBeNull();
	});

	it("paginates all CI contexts against the same commit and all review threads", async () => {
		const { readTaskPullRequest } = await import("../github-pr-status");
		query.mockResolvedValueOnce(payload(pr({
			commits: { nodes: [{ commit: { oid: "fixed-head", statusCheckRollup: { contexts: page([{ name: "one", status: "COMPLETED", conclusion: "SUCCESS" }], "checks-2") } } }] },
			reviewThreads: page([{ isResolved: false }], "threads-2"),
		}))).mockResolvedValueOnce({ repository: { object: { statusCheckRollup: { contexts: page([{ context: "legacy", state: "FAILURE", targetUrl: "https://ci/fail" }]) } } } })
			.mockResolvedValueOnce({ repository: { pullRequest: { reviewThreads: page([{ isResolved: false }]) } } });
		const result = await readTaskPullRequest({}, "/repo", "feat/work", 42);
		expect(result?.pr?.statusCheckRollup).toHaveLength(2);
		expect(result?.pr?.unresolvedCount).toBe(2);
		expect(query.mock.calls[1][2]).toMatchObject({ oid: "fixed-head", after: "checks-2" });
		expect(query.mock.calls[2][2]).toMatchObject({ number: 42, after: "threads-2" });
	});

	it("keeps PR and CI data when later thread pages fail", async () => {
		const { readTaskPullRequest } = await import("../github-pr-status");
		query.mockResolvedValueOnce(payload(pr({ reviewThreads: page([{ isResolved: false }], "more") }))).mockRejectedValueOnce(new Error("thread unavailable"));
		expect((await readTaskPullRequest({}, "/repo", "feat/work", 42))?.pr).toMatchObject({ state: "OPEN", unresolvedCount: null });
	});

	it("does not publish a falsely green partial check list when pagination fails", async () => {
		const { readTaskPullRequest } = await import("../github-pr-status");
		query.mockResolvedValueOnce(payload(pr({ commits: { nodes: [{ commit: { oid: "head", statusCheckRollup: { contexts: page([{ status: "COMPLETED", conclusion: "SUCCESS" }], "more") } } }] } }))).mockRejectedValueOnce(new Error("checks unavailable"));
		expect((await readTaskPullRequest({}, "/repo", "feat/work", 42))?.pr).toMatchObject({ number: 42, statusCheckRollup: null });
	});

	it("keeps PR identity when the token cannot read CI, without claiming green checks", async () => {
		const { readTaskPullRequest } = await import("../github-pr-status");
		const { GitHubGraphQLError } = await import("../github");
		const { commits: _, reviewThreads: __, ...metadata } = pr();
		query.mockRejectedValueOnce(new GitHubGraphQLError("Resource not accessible by personal access token", []))
			.mockResolvedValueOnce({ repository: { open: { nodes: [metadata] } } });
		const result = await readTaskPullRequest({}, "/repo", "feat/work", 42);
		expect(result?.pr).toMatchObject({ number: 42, state: "OPEN", statusCheckRollup: null, unresolvedCount: null });
		expect(query.mock.calls[1][1]).not.toContain("statusCheckRollup");
		await readTaskPullRequest({}, "/repo", "feat/work", 42);
		expect(query).toHaveBeenCalledTimes(2);
	});

	it("includes repository discovery in the fifteen-second request deadline", async () => {
		vi.useFakeTimers(); vi.setSystemTime(0);
		const { readTaskPullRequest } = await import("../github-pr-status");
		run.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true, stdout: JSON.stringify({ nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" }) }), 9000)));
		query.mockImplementationOnce((_account, _query, _variables, signal) => new Promise((resolve, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			setTimeout(() => resolve(payload()), 12000);
		}));
		let finished = false;
		const pending = readTaskPullRequest({}, "/repo", "feat/work", 42).then((result) => { finished = true; return result; });
		await vi.advanceTimersByTimeAsync(14999);
		expect(finished).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(finished).toBe(true);
		expect(await pending).toBeNull();
		expect(query.mock.calls[0][3].aborted).toBe(true);
	});

	it("coalesces board discovery within a minute", async () => {
		const { listOpenPullRequests } = await import("../github-pr-status");
		query.mockResolvedValue({ repository: { pullRequests: { nodes: [{ number: 42, url: "u", headRefName: "b" }] } } });
		await Promise.all([listOpenPullRequests({}, "/repo"), listOpenPullRequests({}, "/repo")]);
		expect(query).toHaveBeenCalledTimes(1);
	});

	it("retries board discovery after an outage without waiting for the cache TTL", async () => {
		const { listOpenPullRequests } = await import("../github-pr-status");
		query.mockRejectedValueOnce(new Error("temporary outage")).mockResolvedValue({ repository: { pullRequests: { nodes: [{ number: 42, headRefName: "feat/work", url: "https://github.com/owner/repo/pull/42" }] } } });
		await expect(listOpenPullRequests({}, "/repo")).rejects.toThrow("temporary outage");
		await expect(listOpenPullRequests({}, "/repo")).resolves.toMatchObject([{ number: 42 }]);
		expect(query).toHaveBeenCalledTimes(2);
	});

	it("preserves merged proof after repository discovery expires and fails, while rich CI still refreshes", async () => {
		vi.useFakeTimers(); vi.setSystemTime(0);
		const { getPullRequestSnapshot, readTaskPullRequest } = await import("../github-pr-status");
		query.mockResolvedValue({ repository: { known: pr({ state: "MERGED" }) } });
		expect(await getPullRequestSnapshot({}, "/repo", 42)).toEqual({ state: "MERGED", headRefName: "feat/work" });
		vi.setSystemTime(5 * 60_000 + 1);
		run.mockResolvedValue({ ok: false, stderr: "offline" });
		expect(await readTaskPullRequest({}, "/repo", "", 42)).toBeNull();
		expect(await getPullRequestSnapshot({}, "/repo", 42)).toEqual({ state: "MERGED", headRefName: "feat/work" });
		run.mockResolvedValue({ ok: true, stdout: JSON.stringify({ nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" }) });
		query.mockResolvedValue({ repository: { known: pr({ state: "MERGED", commits: { nodes: [] } }) } });
		expect((await readTaskPullRequest({}, "/repo", "", 42))?.pr?.statusCheckRollup).toEqual([]);
		expect(query).toHaveBeenCalledTimes(2);
	});

	it("retains merged proof during a concurrent failing repository refresh", async () => {
		vi.useFakeTimers(); vi.setSystemTime(0);
		const { getPullRequestSnapshot, readTaskPullRequest } = await import("../github-pr-status");
		query.mockResolvedValue({ repository: { known: pr({ state: "MERGED" }) } });
		await getPullRequestSnapshot({}, "/repo", 42);
		vi.setSystemTime(5 * 60_000 + 1);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		run.mockImplementationOnce(async () => { await gate; return { ok: false, stderr: "offline" }; });
		const rich = readTaskPullRequest({}, "/repo", "", 42);
		await vi.advanceTimersByTimeAsync(0);
		const proof = getPullRequestSnapshot({}, "/repo", 42);
		await vi.advanceTimersByTimeAsync(0);
		release();
		expect(await rich).toBeNull();
		expect(await proof).toEqual({ state: "MERGED", headRefName: "feat/work" });
	});
});
