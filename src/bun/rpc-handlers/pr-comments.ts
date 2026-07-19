import type { PRReviewComment, PRReviewThread, PRReviewThreadSide, Project, Task, TaskPRCommentsPayload } from "../../shared/types";
import * as data from "../data";
import * as github from "../github";
import { sendMessageImmediately } from "../scheduled-message-scheduler";
import { createLogger } from "../logger";
import { parseGitHubPullRequestUrl } from "./pr-status";

const log = createLogger("pr-comments");

// The diff viewer fetches this payload on open; a re-open within the TTL reuses
// the cached response instead of re-hitting GraphQL. The manual refresh button
// passes `force` and always bypasses.
const PR_COMMENTS_CACHE_TTL_MS = 60_000;
const PR_COMMENTS_TIMEOUT_MS = 20_000;
// GraphQL page size / page-count guards. 100 pages × 50 nodes is far beyond any
// real PR; the cap only prevents a runaway loop on a pathological cursor.
const PAGE_SIZE = 50;
const MAX_PAGES = 100;

const cache = new Map<string, { fetchedAt: number; payload: TaskPRCommentsPayload }>();

/** Test-only: clear the per-task payload cache. */
export function _resetPrCommentsCache(): void {
	cache.clear();
}

function asString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Normalize one GraphQL comment node (review-thread comment or issue comment)
 * into the shared shape. Returns null for nodes missing the essentials, so a
 * partially-errored GraphQL response degrades to fewer comments, not a crash.
 */
export function parsePrComment(node: unknown): PRReviewComment | null {
	if (!node || typeof node !== "object") return null;
	const c = node as Record<string, unknown>;
	const id = asString(c.id);
	const body = asString(c.body);
	const createdAt = asString(c.createdAt);
	const url = asString(c.url);
	if (!id || body === null || !createdAt || !url) return null;
	const author = c.author && typeof c.author === "object" ? (c.author as Record<string, unknown>) : null;
	const login = author ? asString(author.login) : null;
	const typename = author ? asString(author.__typename) : null;
	return {
		id,
		author: login,
		isBot: typename === "Bot" || (login?.endsWith("[bot]") ?? false),
		body,
		createdAt,
		url,
	};
}

/** Normalize one GraphQL `reviewThreads` node; null when the node is unusable. */
export function parsePrReviewThread(node: unknown): PRReviewThread | null {
	if (!node || typeof node !== "object") return null;
	const t = node as Record<string, unknown>;
	const id = asString(t.id);
	const path = asString(t.path);
	if (!id || !path) return null;
	const commentsNode = t.comments && typeof t.comments === "object"
		? (t.comments as Record<string, unknown>).nodes
		: null;
	const comments = Array.isArray(commentsNode)
		? commentsNode.map(parsePrComment).filter((c): c is PRReviewComment => c !== null)
		: [];
	if (comments.length === 0) return null;
	const diffSide: PRReviewThreadSide = t.diffSide === "LEFT" ? "LEFT" : "RIGHT";
	return {
		id,
		path,
		line: asFiniteNumber(t.line),
		originalLine: asFiniteNumber(t.originalLine),
		startLine: asFiniteNumber(t.startLine),
		diffSide,
		isResolved: t.isResolved === true,
		isOutdated: t.isOutdated === true,
		comments,
	};
}

const REVIEW_THREADS_PAGE_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${PAGE_SIZE}, after: $after) {
        nodes {
          id path line originalLine startLine diffSide isResolved isOutdated
          comments(first: ${PAGE_SIZE}) {
            nodes { id body createdAt url author { login __typename } }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const CONVERSATION_PAGE_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      comments(first: ${PAGE_SIZE}, after: $after) {
        nodes { id body createdAt url author { login __typename } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

type GraphQLConnection = {
	nodes?: unknown;
	pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
};

async function fetchAllPages(
	project: Project,
	cwd: string,
	repo: { host: string; owner: string; repo: string },
	prNumber: number,
	query: string,
	field: "reviewThreads" | "comments",
): Promise<unknown[]> {
	const nodes: unknown[] = [];
	let after: string | null = null;
	for (let page = 0; page < MAX_PAGES; page++) {
		const result = await github.runGitHub(
			project,
			cwd,
			[
				"api",
				"graphql",
				"--hostname",
				repo.host,
				"-f",
				`query=${query}`,
				"-F",
				`owner=${repo.owner}`,
				"-F",
				`name=${repo.repo}`,
				"-F",
				`number=${prNumber}`,
				"-F",
				`after=${after ?? "null"}`,
			],
			{ timeoutMs: PR_COMMENTS_TIMEOUT_MS },
		);
		if (!result.ok || !result.stdout) {
			throw new Error(result.stderr || `GitHub GraphQL ${field} request failed`);
		}
		const payload = JSON.parse(result.stdout) as {
			data?: { repository?: { pullRequest?: Record<string, GraphQLConnection | undefined> | null } };
			errors?: Array<{ message?: string }>;
		};
		if (payload.errors?.length) {
			throw new Error(payload.errors[0]?.message || `GitHub GraphQL ${field} request returned errors`);
		}
		const connection = payload.data?.repository?.pullRequest?.[field];
		if (!connection) {
			throw new Error(`GitHub GraphQL response has no pullRequest.${field}`);
		}
		if (Array.isArray(connection.nodes)) nodes.push(...connection.nodes);
		if (!connection.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) return nodes;
		after = connection.pageInfo.endCursor;
	}
	return nodes;
}

async function fetchTaskPrComments(project: Project, task: Task): Promise<TaskPRCommentsPayload | null> {
	const prNumber = task.prNumber;
	const prUrl = task.prUrl;
	if (prNumber == null || !prUrl) return null;
	const repo = parseGitHubPullRequestUrl(prUrl);
	if (!repo) return null;
	const cwd = task.worktreePath ?? project.path;

	const [threadNodes, conversationNodes] = await Promise.all([
		fetchAllPages(project, cwd, repo, prNumber, REVIEW_THREADS_PAGE_QUERY, "reviewThreads"),
		fetchAllPages(project, cwd, repo, prNumber, CONVERSATION_PAGE_QUERY, "comments"),
	]);

	return {
		prNumber,
		prUrl,
		fetchedAt: new Date().toISOString(),
		threads: threadNodes.map(parsePrReviewThread).filter((t): t is PRReviewThread => t !== null),
		conversation: conversationNodes.map(parsePrComment).filter((c): c is PRReviewComment => c !== null),
	};
}

async function getTaskPrComments(params: { taskId: string; projectId: string; force?: boolean }): Promise<TaskPRCommentsPayload | null> {
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	if (task.prNumber == null || !task.prUrl) return null;

	const cached = cache.get(task.id);
	if (!params.force && cached && Date.now() - cached.fetchedAt < PR_COMMENTS_CACHE_TTL_MS && cached.payload.prNumber === task.prNumber) {
		return cached.payload;
	}

	const payload = await fetchTaskPrComments(project, task);
	if (payload) {
		cache.set(task.id, { fetchedAt: Date.now(), payload });
	}
	log.debug("PR comments fetched", {
		taskId: task.id.slice(0, 8),
		pr: task.prNumber,
		threads: payload?.threads.length ?? 0,
		conversation: payload?.conversation.length ?? 0,
	});
	return payload;
}

async function sendAgentMessageNow(params: { taskId: string; projectId: string; text: string }): Promise<void> {
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	await sendMessageImmediately(task, params.text);
}

export const prCommentsHandlers = {
	getTaskPrComments,
	sendAgentMessageNow,
};
