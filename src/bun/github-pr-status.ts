import type { GitHubAccount, PRInfo, Project } from "../shared/types";
import { createLogger } from "./logger";
import { countUnresolvedReviewThreads } from "./rpc-handlers/pr-status";
import { GitHubGraphQLError, isNotAGitHubRepoError, queryGitHub, resolveGitHubAccount, runGitHub, type PullRequestSnapshot } from "./github";

const log = createLogger("github-pr-status");
const STATUS_TTL_MS = 60_000;
const REPOSITORY_TTL_MS = 5 * 60_000;
type Selection = Pick<Project, "githubAuthHost" | "githubAuthLogin">;
type Page<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
type Check = { name?: string; status?: string; conclusion?: string | null; detailsUrl?: string; context?: string; state?: string; targetUrl?: string };

export interface GitHubPullRequestSummary {
	number: number;
	url: string;
	title: string;
	state: string;
	headRefName: string;
	headRefOid: string;
	isDraft: boolean;
	autoMergeRequest: { enabledAt: string } | null;
	mergeable: string;
	mergeStateStatus: string;
	reviewDecision: string | null;
	author: { login: string; name?: string | null } | null;
	statusCheckRollup: Check[] | null;
	unresolvedCount: number | null;
}

type ApiPR = Omit<GitHubPullRequestSummary, "statusCheckRollup" | "unresolvedCount"> & {
	commits?: { nodes: { commit: { oid: string; statusCheckRollup: { contexts: Page<Check> } | null } }[] };
	reviewThreads?: Page<{ isResolved: boolean }>;
};
type PRResponse = { repository: { open?: { nodes: ApiPR[] }; known?: ApiPR | null } };

type Repository = { owner: string; name: string; host: string };
type Probe = { pr: GitHubPullRequestSummary | null; isGitHub: boolean; checkedAt: number };
type Entry<T> = { at: number; promise: Promise<T> };
const repositories = new Map<string, Entry<Repository | null> & { lastResolved?: Repository | null }>();
const statuses = new Map<string, Entry<Probe | null>>();
const snapshots = new Map<string, { at: number; pr: GitHubPullRequestSummary }>();
const lists = new Map<string, Entry<PRInfo[]>>();
// A repository GitHub says does not exist (deleted, renamed away, access revoked) is not
// asked again on every poll: exponential backoff per repository, cleared by any success.
const MISSING_REPOSITORY_BACKOFF_BASE_MS = 5 * 60_000;
const MISSING_REPOSITORY_BACKOFF_MAX_MS = 6 * 60 * 60_000;
const missingRepositories = new Map<string, { at: number; failures: number }>();

function missingRepositoryBackoffMs(failures: number): number {
	return Math.min(MISSING_REPOSITORY_BACKOFF_BASE_MS * 2 ** (failures - 1), MISSING_REPOSITORY_BACKOFF_MAX_MS);
}

function isRepositoryInBackoff(repoKey: string, now: number): boolean {
	const missing = missingRepositories.get(repoKey);
	return !!missing && now - missing.at < missingRepositoryBackoffMs(missing.failures);
}

function isMissingRepositoryError(error: unknown): boolean {
	return error instanceof GitHubGraphQLError
		&& error.errors.some((item) => item.type === "NOT_FOUND" && item.path?.length === 1 && item.path[0] === "repository");
}

const CHECK_FIELDS = `nodes {
  ... on CheckRun { name status conclusion detailsUrl }
  ... on StatusContext { context state targetUrl }
} pageInfo { hasNextPage endCursor }`;
const PR_METADATA_FIELDS = `number url title state headRefName headRefOid isDraft
  author { login ... on User { name } }
  autoMergeRequest { enabledAt } mergeable mergeStateStatus reviewDecision`;
const PR_FIELDS = `${PR_METADATA_FIELDS}
  commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: 100) { ${CHECK_FIELDS} } } } } }
  reviewThreads(first: 100) { nodes { isResolved } pageInfo { hasNextPage endCursor } }`;
function pullRequestQuery(fields: string): string {
	return `query($owner: String!, $name: String!, $branch: String!, $number: Int!, $byBranch: Boolean!, $known: Boolean!) {
  repository(owner: $owner, name: $name) {
    open: pullRequests(headRefName: $branch, states: OPEN, first: 1, orderBy: {field: CREATED_AT, direction: DESC}) @include(if: $byBranch) { nodes { ${fields} } }
    known: pullRequest(number: $number) @include(if: $known) { ${fields} }
  }
}`;
}
const PR_QUERY = pullRequestQuery(PR_FIELDS);
const PR_METADATA_QUERY = pullRequestQuery(PR_METADATA_FIELDS);
const CHECKS_QUERY = `query($owner: String!, $name: String!, $oid: GitObjectID!, $after: String!) {
  repository(owner: $owner, name: $name) { object(oid: $oid) { ... on Commit {
    statusCheckRollup { contexts(first: 100, after: $after) { ${CHECK_FIELDS} } }
  } } }
}`;
const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 100, after: $after) { nodes { isResolved } pageInfo { hasNextPage endCursor } }
  } }
}`;

function identity(account: GitHubAccount, repository: Repository): string {
	return `${account.host}\0${account.login}\0${repository.owner}/${repository.name}`;
}

async function resolveRepository(project: Selection, cwd: string, account: GitHubAccount, timeoutMs: number, forMergeProof = false): Promise<Repository | null> {
	const key = `${account.host}\0${account.login}\0${cwd}`;
	const cached = repositories.get(key);
	if (forMergeProof && cached?.lastResolved !== undefined) return cached.lastResolved;
	if (cached && Date.now() - cached.at < REPOSITORY_TTL_MS) return await cached.promise;
	const promise = (async () => {
		// gh resolves SSH aliases and its selected base repository; parsing origin loses both.
		const result = await runGitHub(project, cwd, ["repo", "view", "--json", "nameWithOwner,url"], { timeoutMs: Math.min(10_000, timeoutMs) });
		if (!result.ok) {
			if (isNotAGitHubRepoError(result)) return null;
			throw new Error(result.stderr || "Could not resolve GitHub repository");
		}
		const repo = JSON.parse(result.stdout) as { nameWithOwner: string; url: string };
		const [owner, name] = repo.nameWithOwner.split("/");
		const host = new URL(repo.url).hostname;
		if (!owner || !name || host.toLowerCase() !== account.host.toLowerCase()) {
			throw new Error("GitHub repository does not match the selected account host");
		}
		return { owner, name, host };
	})();
	const entry = { at: Date.now(), promise, lastResolved: cached?.lastResolved };
	repositories.set(key, entry);
	try { return entry.lastResolved = await promise; } catch (error) {
		if (repositories.get(key) === entry) {
			if (cached) repositories.set(key, cached);
			else repositories.delete(key);
		}
		throw error;
	}
}

async function completePR(account: GitHubAccount, repo: Repository, pr: ApiPR, signal: AbortSignal): Promise<GitHubPullRequestSummary> {
	if (typeof pr.number !== "number" || typeof pr.url !== "string" || typeof pr.headRefName !== "string"
		|| !["OPEN", "MERGED", "CLOSED"].includes(pr.state)) throw new Error("GitHub returned an invalid PR identity or state");
	const commit = pr.commits?.nodes[0]?.commit;
	let checksPage = commit?.statusCheckRollup?.contexts;
	let checks: Check[] | null = pr.commits ? [...(checksPage?.nodes ?? [])] : null;
	try {
		while (checksPage?.pageInfo.hasNextPage) {
			if (!checksPage.pageInfo.endCursor) throw new Error("GitHub checks page is missing its cursor");
			const data = await queryGitHub<{ repository: { object: { statusCheckRollup: { contexts: Page<Check> } } } }>(
				account, CHECKS_QUERY, { ...repo, oid: commit!.oid, after: checksPage.pageInfo.endCursor }, signal,
			);
			checksPage = data.repository.object.statusCheckRollup.contexts;
			checks!.push(...checksPage.nodes);
		}
	} catch (error) {
		log.warn("PR check pagination failed", { pr: pr.number, error: String(error) });
		checks = null;
	}
	let threads = pr.reviewThreads;
	let unresolvedCount: number | null = threads ? countUnresolvedReviewThreads(threads.nodes) : null;
	try {
		while (threads?.pageInfo.hasNextPage) {
			if (!threads.pageInfo.endCursor) throw new Error("GitHub review-thread page is missing its cursor");
			const data = await queryGitHub<{ repository: { pullRequest: { reviewThreads: Page<{ isResolved: boolean }> } } }>(
				account, THREADS_QUERY, { ...repo, number: pr.number, after: threads.pageInfo.endCursor }, signal,
			);
			threads = data.repository.pullRequest.reviewThreads;
			unresolvedCount! += countUnresolvedReviewThreads(threads.nodes);
		}
	} catch (error) {
		log.warn("PR review-thread pagination failed", { pr: pr.number, error: String(error) });
		unresolvedCount = null;
	}
	signal.throwIfAborted();
	const { commits: _, reviewThreads: __, ...summary } = pr;
	return { ...summary, statusCheckRollup: checks, unresolvedCount };
}

async function withinDeadline<T>(fn: (signal: AbortSignal, deadline: number) => Promise<T>, timeoutMs: number): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			const error = new Error(`GitHub PR read timed out after ${timeoutMs}ms`);
			controller.abort(error);
			reject(error);
		}, timeoutMs);
	});
	try { return await Promise.race([fn(controller.signal, Date.now() + timeoutMs), timeout]); }
	finally { clearTimeout(timer!); }
}

// A cached in-flight read must not outlive its owner's deadline: a step that ignores the
// signal (token lookup, a stuck spawn) would otherwise keep every later joiner waiting forever.
function settleOnAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

async function queryPR(account: GitHubAccount, query: string, variables: Record<string, unknown>, signal: AbortSignal): Promise<PRResponse> {
	try { return await queryGitHub<PRResponse>(account, query, variables, signal); }
	catch (error) {
		if (error instanceof GitHubGraphQLError && error.data && error.errors.length > 0
			&& error.errors.every((item) => item.type === "NOT_FOUND" && item.path?.length === 2 && item.path[0] === "repository" && item.path[1] === "known")) {
			return error.data as PRResponse;
		}
		throw error;
	}
}

export async function getPullRequestSnapshot(project: Selection, cwd: string, prNumber: number): Promise<PullRequestSnapshot | null> {
	try {
		return await withinDeadline(async (signal, deadline) => {
			const account = await resolveGitHubAccount(project);
			signal.throwIfAborted();
			const repo = await resolveRepository(project, cwd, account, deadline - Date.now(), true);
			signal.throwIfAborted();
			if (!repo) return null;
			const cached = snapshots.get(`${identity(account, repo)}#${prNumber}`)?.pr;
			// MERGED is immutable; only rich CI/review status needs to expire.
			if (cached?.state === "MERGED") return { state: cached.state, headRefName: cached.headRefName };
			const result = await readTaskPullRequest(project, cwd, "", prNumber, { timeoutMs: deadline - Date.now() });
			return result?.pr ? { state: result.pr.state, headRefName: result.pr.headRefName } : null;
		}, 15_000);
	} catch (error) {
		log.warn("PR snapshot lookup failed", { pr: prNumber, error: String(error) });
		return null;
	}
}

export async function readTaskPullRequest(
	project: Selection,
	cwd: string,
	branch: string,
	prNumber?: number | null,
	options?: { force?: boolean; timeoutMs?: number },
): Promise<Probe | null> {
	try {
		return await withinDeadline(async (signal, deadline) => {
			const account = await resolveGitHubAccount(project);
			signal.throwIfAborted();
			const repo = await resolveRepository(project, cwd, account, deadline - Date.now());
			signal.throwIfAborted();
			if (!repo) return { pr: null, isGitHub: false, checkedAt: Date.now() };
			const repoKey = identity(account, repo);
			if (!options?.force && isRepositoryInBackoff(repoKey, Date.now())) return null;
			if (!branch && prNumber != null && !options?.force) {
				const cached = snapshots.get(`${repoKey}#${prNumber}`);
				if (cached && Date.now() - cached.at < STATUS_TTL_MS) return { pr: cached.pr, isGitHub: true, checkedAt: cached.at };
			}
			const key = `${repoKey}\0${branch}\0${prNumber ?? ""}`;
			const cached = statuses.get(key);
			// A forced refresh still joins an in-flight read; it only bypasses completed results.
			if (cached && (cached.at === Infinity || (!options?.force && Date.now() - cached.at < STATUS_TTL_MS))) return await cached.promise;
			const promise = settleOnAbort((async (): Promise<Probe> => {
				let data;
				const variables = { owner: repo.owner, name: repo.name, branch, number: prNumber ?? 0, byBranch: !!branch, known: prNumber != null };
				try {
					data = await queryPR(account, PR_QUERY, variables, signal);
				} catch (error) {
					if (!(error instanceof GitHubGraphQLError)) throw error;
					if (isMissingRepositoryError(error)) {
						const failures = (missingRepositories.get(repoKey)?.failures ?? 0) + 1;
						missingRepositories.set(repoKey, { at: Date.now(), failures });
						throw new Error(`${error.message} (next check in ${Math.round(missingRepositoryBackoffMs(failures) / 60_000)} min)`);
					}
					signal.throwIfAborted();
					data = await queryPR(account, PR_METADATA_QUERY, variables, signal);
				}
				const raw = data.repository.open?.nodes[0] ?? data.repository.known;
				if (prNumber != null && !raw) throw new Error("GitHub did not return the saved pull request");
				missingRepositories.delete(repoKey);
				const pr = raw ? await completePR(account, repo, raw, signal) : null;
				const checkedAt = Date.now();
				if (pr) snapshots.set(`${repoKey}#${pr.number}`, { at: checkedAt, pr });
				return { pr, isGitHub: true, checkedAt };
			})(), signal);
			const entry = { at: Infinity, promise };
			statuses.set(key, entry);
			try {
				const result = await promise;
				entry.at = result.checkedAt;
				if (result.pr && result.pr.headRefName === branch) statuses.set(`${repoKey}\0${branch}\0${result.pr.number}`, entry);
				return result;
			} catch (error) {
				if (statuses.get(key) === entry) statuses.delete(key);
				throw error;
			}
		}, options?.timeoutMs ?? 15_000);
	} catch (error) {
		log.warn("PR status lookup failed", { pr: prNumber, error: String(error) });
		return null;
	}
}

export async function listOpenPullRequests(project: Selection, cwd: string): Promise<PRInfo[]> {
	return withinDeadline(async (signal, deadline) => {
		const account = await resolveGitHubAccount(project);
		signal.throwIfAborted();
		const repo = await resolveRepository(project, cwd, account, deadline - Date.now());
		signal.throwIfAborted();
		if (!repo) return [];
		const key = identity(account, repo);
		const cached = lists.get(key);
		if (cached && Date.now() - cached.at < STATUS_TTL_MS) return await cached.promise;
		const promise = settleOnAbort(queryGitHub<{ repository: { pullRequests: { nodes: PRInfo[] } } }>(account,
			`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
			  pullRequests(states: OPEN, first: 100, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number url headRefName } }
			} }`, { owner: repo.owner, name: repo.name }, signal,
		).then((data) => data.repository.pullRequests.nodes), signal);
		const entry = { at: Date.now(), promise };
		lists.set(key, entry);
		try { return await promise; } catch (error) {
			if (lists.get(key) === entry) lists.delete(key);
			throw error;
		}
	}, 15_000);
}
