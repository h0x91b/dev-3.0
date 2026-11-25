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
		commits: { nodes: [{ commit: { oid: "head", committedDate: "2026-11-20T10:00:00Z", statusCheckRollup: { contexts: page([{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }]) } } }] },
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
	it("uses one query for PR, CI, unresolved-thread status, author and head commit date", async () => {
		const { readTaskPullRequest } = await import("../github-pr-status");
		const result = await readTaskPullRequest({}, "/repo", "feat/work", 42);
		expect(query).toHaveBeenCalledTimes(1);
		expect(query).toHaveBeenCalledWith(account, expect.stringContaining("reviewThreads"), expect.objectContaining({ branch: "feat/work", number: 42, byBranch: true, known: true }), expect.any(AbortSignal));
		expect(result?.pr).toMatchObject({ number: 42, state: "OPEN", unresolvedCount: 1, statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }] });

		// It carries the author and the head commit's date, and no date when the PR has no commits.
		const { prSummaryStatus } = await import("../rpc-handlers/pr-status");
		expect(query.mock.calls[0][1]).toContain("committedDate");
		expect(prSummaryStatus(result!.pr!)).toMatchObject({ authorLogin: "author", lastCommitAt: "2026-11-20T10:00:00Z" });
		expect(prSummaryStatus({ ...result!.pr!, author: null, lastCommitAt: undefined })).toMatchObject({ authorLogin: null, lastCommitAt: null });
	});

	it("shares both in-flight and recent reads across worktrees, and number snapshots", async () => {
		const { readTaskPullRequest } = await import("../github-pr-status");
		await Promise.all(Array.from({ length: 10 }, () => readTaskPullRequest({}, "/repo", "feat/work", 42)));
		await readTaskPullRequest({}, "/other-worktree", "feat/work", 42);
		await readTaskPullRequest({}, "/repo", "", 42);
		expect(query).toHaveBeenCalledTimes(1);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("expires OPEN after a minute and reports CLOSED, without waiting for restart", async () => {
		const state = "CLOSED";
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

	it("reads a PR with mergedAt as MERGED even while GitHub's state still says CLOSED", async () => {
		const { readTaskPullRequest } = await import("../github-pr-status");
		query.mockResolvedValue({ repository: { known: pr({ state: "CLOSED", mergedAt: "2026-11-03T10:00:00Z" }) } });
		const read = (await readTaskPullRequest({}, "/repo", "", 42))?.pr;
		expect(read?.state).toBe("MERGED");
		expect(read).not.toHaveProperty("mergedAt");
		expect(query.mock.calls[0][1]).toContain("mergedAt");

		vi.resetModules();
		const fresh = await import("../github-pr-status");
		query.mockResolvedValue({ repository: { known: pr({ state: "CLOSED", mergedAt: null }) } });
		expect((await fresh.readTaskPullRequest({}, "/repo", "", 42))?.pr?.state).toBe("CLOSED");
	});

	it("prefers a new open PR, never returns it as the saved number's snapshot, and keeps saved history after a branch change", async () => {
		const { readTaskPullRequest } = await import("../github-pr-status");
		query.mockResolvedValueOnce({ repository: { open: { nodes: [pr({ number: 43 })] }, known: pr({ state: "MERGED" }) } });
		expect((await readTaskPullRequest({}, "/repo", "feat/work", 42))?.pr?.number).toBe(43);
		query.mockResolvedValueOnce({ repository: { known: pr({ state: "MERGED" }) } });
		expect((await readTaskPullRequest({}, "/repo", "", 42))?.pr).toMatchObject({ number: 42, state: "MERGED" });

		// Saved PR history survives a branch change or deletion.
		query.mockResolvedValue({ repository: { open: { nodes: [] }, known: pr({ state: "MERGED", headRefName: "old/branch" }) } });
		expect((await readTaskPullRequest({}, "/repo", "follow-up", 42, { force: true }))?.pr).toMatchObject({ state: "MERGED", headRefName: "old/branch" });
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

	it("distinguishes a non-GitHub remote from an unavailable API, and no open PR from an unavailable saved one", async () => {
		const { readTaskPullRequest } = await import("../github-pr-status");
		run.mockResolvedValue({ ok: false, stderr: "no git remotes found" });
		expect(await readTaskPullRequest({}, "/non-github", "feat/work")).toEqual({ pr: null, isGitHub: false, checkedAt: expect.any(Number) });
		query.mockRejectedValue(new Error("offline"));
		run.mockResolvedValue({ ok: true, stdout: JSON.stringify({ nameWithOwner: "owner/repo", url: "https://github.com/owner/repo" }) });
		expect(await readTaskPullRequest({}, "/repo", "feat/work", 42)).toBeNull();
		expect(await readTaskPullRequest({}, "/repo", "feat/work", 42)).toBeNull();
		expect(query).toHaveBeenCalledTimes(2);

		// No open PR is distinguished from an unavailable saved PR.
		query.mockResolvedValue({ repository: { open: { nodes: [] }, known: null } });
		expect(await readTaskPullRequest({}, "/repo", "other/branch")).toEqual({ pr: null, isGitHub: true, checkedAt: expect.any(Number) });
		expect(await readTaskPullRequest({}, "/repo", "other/branch", 43)).toBeNull();
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

		// Partial branch data with unrelated GraphQL errors is not accepted.
		query.mockRejectedValue(new GitHubGraphQLError("Cannot read branch PRs", [{ type: "FORBIDDEN", path: ["repository", "open"] }], payload()));
		expect(await readTaskPullRequest({}, "/repo", "feat/work", 998)).toBeNull();
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

	it("keeps PR and CI data when later thread pages fail, but never a falsely green partial check list", async () => {
		const { readTaskPullRequest } = await import("../github-pr-status");
		query.mockResolvedValueOnce(payload(pr({ reviewThreads: page([{ isResolved: false }], "more") }))).mockRejectedValueOnce(new Error("thread unavailable"));
		expect((await readTaskPullRequest({}, "/repo", "feat/work", 42))?.pr).toMatchObject({ state: "OPEN", unresolvedCount: null });

		// A falsely green partial check list is never published when CI pagination fails.
		vi.resetModules();
		const fresh = await import("../github-pr-status");
		query.mockResolvedValueOnce(payload(pr({ commits: { nodes: [{ commit: { oid: "head", statusCheckRollup: { contexts: page([{ status: "COMPLETED", conclusion: "SUCCESS" }], "more") } } }] } }))).mockRejectedValueOnce(new Error("checks unavailable"));
		expect((await fresh.readTaskPullRequest({}, "/repo", "feat/work", 42))?.pr).toMatchObject({ number: 42, statusCheckRollup: null });
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

	it("evicts an in-flight status read that never settles once its deadline passes", async () => {
		vi.useFakeTimers(); vi.setSystemTime(0);
		const { readTaskPullRequest } = await import("../github-pr-status");
		query.mockImplementationOnce(() => new Promise(() => {}));
		const hung = readTaskPullRequest({}, "/repo", "feat/work", 42);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(await hung).toBeNull();
		await expect(readTaskPullRequest({}, "/repo", "feat/work", 42)).resolves.toMatchObject({ pr: { number: 42 } });
		expect(query).toHaveBeenCalledTimes(2);
	});

	it("releases a forced refresh that joined a hung read at the owner's deadline", async () => {
		vi.useFakeTimers(); vi.setSystemTime(0);
		const { readTaskPullRequest } = await import("../github-pr-status");
		query.mockImplementationOnce(() => new Promise(() => {}));
		const hung = readTaskPullRequest({}, "/repo", "feat/work", null);
		await vi.advanceTimersByTimeAsync(5_000);
		let joined = false;
		const forced = readTaskPullRequest({}, "/repo", "feat/work", null, { force: true }).then((result) => { joined = true; return result; });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await hung).toBeNull();
		await vi.advanceTimersByTimeAsync(0);
		expect(joined).toBe(true);
		expect(await forced).toBeNull();
		await expect(readTaskPullRequest({}, "/repo", "feat/work", null, { force: true })).resolves.toMatchObject({ pr: { number: 42 } });
		expect(query).toHaveBeenCalledTimes(2);
	});

	it("evicts a hung or failed board discovery without waiting for the cache TTL, then coalesces it", async () => {
		vi.useFakeTimers(); vi.setSystemTime(0);
		const { listOpenPullRequests } = await import("../github-pr-status");
		query.mockImplementationOnce(() => new Promise(() => {}))
			.mockResolvedValue({ repository: { pullRequests: { nodes: [{ number: 42, url: "u", headRefName: "b" }] } } });
		const hung = listOpenPullRequests({}, "/repo");
		const expectation = expect(hung).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(15_000);
		await expectation;
		await expect(listOpenPullRequests({}, "/repo")).resolves.toMatchObject([{ number: 42 }]);
		// Retried without waiting for the cache TTL, then coalesced within a minute.
		await Promise.all([listOpenPullRequests({}, "/repo"), listOpenPullRequests({}, "/repo")]);
		expect(query).toHaveBeenCalledTimes(2);

		vi.resetModules();
		const fresh = await import("../github-pr-status");
		query.mockRejectedValueOnce(new Error("temporary outage"));
		await expect(fresh.listOpenPullRequests({}, "/repo")).rejects.toThrow("temporary outage");
		await expect(fresh.listOpenPullRequests({}, "/repo")).resolves.toMatchObject([{ number: 42 }]);
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

describe("missing repository backoff", () => {
	async function missingRepository() {
		const { GitHubGraphQLError } = await import("../github");
		return new GitHubGraphQLError("GitHub GraphQL: Could not resolve to a Repository with the name 'owner/repo'.", [{ type: "NOT_FOUND", path: ["repository"] }]);
	}

	it("stops asking GitHub about a repository that does not exist, with a doubling backoff", async () => {
		vi.useFakeTimers(); vi.setSystemTime(0);
		const { readTaskPullRequest } = await import("../github-pr-status");
		query.mockRejectedValue(await missingRepository());
		expect(await readTaskPullRequest({}, "/repo", "feat/work", 42)).toBeNull();
		// No metadata-only retry: the repository itself is missing.
		expect(query).toHaveBeenCalledTimes(1);

		vi.setSystemTime(5 * 60_000 - 1);
		expect(await readTaskPullRequest({}, "/repo", "feat/work", 42)).toBeNull();
		expect(await readTaskPullRequest({}, "/other-worktree", "other/branch", null)).toBeNull();
		expect(query).toHaveBeenCalledTimes(1);

		vi.setSystemTime(5 * 60_000);
		expect(await readTaskPullRequest({}, "/repo", "feat/work", 42)).toBeNull();
		expect(query).toHaveBeenCalledTimes(2);

		vi.setSystemTime(5 * 60_000 + 10 * 60_000 - 1);
		expect(await readTaskPullRequest({}, "/repo", "feat/work", 42)).toBeNull();
		expect(query).toHaveBeenCalledTimes(2);
	});

	it("a forced refresh bypasses the backoff and a success clears it", async () => {
		vi.useFakeTimers(); vi.setSystemTime(0);
		const { readTaskPullRequest } = await import("../github-pr-status");
		query.mockRejectedValue(await missingRepository());
		await readTaskPullRequest({}, "/repo", "feat/work", 42);
		query.mockReset().mockResolvedValue(payload());
		expect((await readTaskPullRequest({}, "/repo", "feat/work", 42, { force: true }))?.pr?.number).toBe(42);

		vi.setSystemTime(60_000);
		expect((await readTaskPullRequest({}, "/repo", "feat/work", 42))?.pr?.number).toBe(42);
		expect(query).toHaveBeenCalledTimes(2);
	});
});
