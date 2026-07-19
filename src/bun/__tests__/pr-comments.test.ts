import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const getProject = vi.fn();
const getTask = vi.fn();
vi.mock("../data", () => ({
	getProject: (...args: unknown[]) => getProject(...args),
	getTask: (...args: unknown[]) => getTask(...args),
}));

const runGitHub = vi.fn();
vi.mock("../github", () => ({
	runGitHub: (...args: unknown[]) => runGitHub(...args),
}));

const sendMessageImmediately = vi.fn();
vi.mock("../scheduled-message-scheduler", () => ({
	sendMessageImmediately: (...args: unknown[]) => sendMessageImmediately(...args),
}));

import { _resetPrCommentsCache, parsePrComment, parsePrReviewThread, prCommentsHandlers } from "../rpc-handlers/pr-comments";

const project = { id: "p1", path: "/tmp/proj" };
const task = {
	id: "t1",
	prNumber: 42,
	prUrl: "https://github.com/acme/widget/pull/42",
	worktreePath: "/tmp/wt/t1",
	status: "in-progress",
};

function commentNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "c1",
		body: "Please rename this.",
		createdAt: "2026-07-18T10:00:00Z",
		url: "https://github.com/acme/widget/pull/42#discussion_r1",
		author: { login: "alice", __typename: "User" },
		...overrides,
	};
}

function threadNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "th1",
		path: "src/app.ts",
		line: 10,
		originalLine: 8,
		startLine: null,
		diffSide: "RIGHT",
		isResolved: false,
		isOutdated: false,
		comments: { nodes: [commentNode()] },
		...overrides,
	};
}

function graphqlResponse(field: "reviewThreads" | "comments", nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
	return {
		ok: true,
		code: 0,
		stderr: "",
		stdout: JSON.stringify({
			data: {
				repository: {
					pullRequest: {
						[field]: { nodes, pageInfo: { hasNextPage, endCursor } },
					},
				},
			},
		}),
	};
}

/** Route the mocked gh calls by which GraphQL query they carry. */
function mockGraphQL(handlers: {
	reviewThreads: Array<ReturnType<typeof graphqlResponse>>;
	comments: Array<ReturnType<typeof graphqlResponse>>;
}) {
	const remaining = {
		reviewThreads: [...handlers.reviewThreads],
		comments: [...handlers.comments],
	};
	runGitHub.mockImplementation(async (_project: unknown, _cwd: unknown, args: string[]) => {
		const query = args.find((arg) => arg.startsWith("query="));
		const field = query?.includes("reviewThreads(") ? "reviewThreads" : "comments";
		const next = remaining[field].shift();
		if (!next) throw new Error(`unexpected extra ${field} page request`);
		return next;
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	_resetPrCommentsCache();
	getProject.mockResolvedValue(project);
	getTask.mockResolvedValue(task);
});

describe("parsePrComment", () => {
	it("normalizes a full node", () => {
		expect(parsePrComment(commentNode())).toEqual({
			id: "c1",
			author: "alice",
			isBot: false,
			body: "Please rename this.",
			createdAt: "2026-07-18T10:00:00Z",
			url: "https://github.com/acme/widget/pull/42#discussion_r1",
		});
	});

	it("flags bots via __typename and the [bot] login suffix", () => {
		expect(parsePrComment(commentNode({ author: { login: "cursor", __typename: "Bot" } }))?.isBot).toBe(true);
		expect(parsePrComment(commentNode({ author: { login: "claude[bot]", __typename: "User" } }))?.isBot).toBe(true);
	});

	it("keeps a null author for ghost accounts", () => {
		expect(parsePrComment(commentNode({ author: null }))?.author).toBeNull();
	});

	it("rejects nodes missing essentials", () => {
		expect(parsePrComment(null)).toBeNull();
		expect(parsePrComment(commentNode({ url: undefined }))).toBeNull();
		expect(parsePrComment(commentNode({ body: 7 }))).toBeNull();
	});
});

describe("parsePrReviewThread", () => {
	it("normalizes a full node", () => {
		expect(parsePrReviewThread(threadNode())).toMatchObject({
			id: "th1",
			path: "src/app.ts",
			line: 10,
			originalLine: 8,
			startLine: null,
			diffSide: "RIGHT",
			isResolved: false,
			isOutdated: false,
		});
	});

	it("maps LEFT diffSide and null line", () => {
		const thread = parsePrReviewThread(threadNode({ diffSide: "LEFT", line: null }));
		expect(thread?.diffSide).toBe("LEFT");
		expect(thread?.line).toBeNull();
	});

	it("drops threads with no usable comments", () => {
		expect(parsePrReviewThread(threadNode({ comments: { nodes: [] } }))).toBeNull();
		expect(parsePrReviewThread(threadNode({ comments: { nodes: [{ id: "broken" }] } }))).toBeNull();
	});

	it("drops nodes without id or path", () => {
		expect(parsePrReviewThread(threadNode({ path: undefined }))).toBeNull();
	});
});

describe("getTaskPrComments", () => {
	it("returns null without touching gh when the task has no PR", async () => {
		getTask.mockResolvedValue({ ...task, prNumber: null, prUrl: null });
		const result = await prCommentsHandlers.getTaskPrComments({ taskId: "t1", projectId: "p1" });
		expect(result).toBeNull();
		expect(runGitHub).not.toHaveBeenCalled();
	});

	it("fetches threads and conversation and assembles the payload", async () => {
		mockGraphQL({
			reviewThreads: [graphqlResponse("reviewThreads", [threadNode()])],
			comments: [graphqlResponse("comments", [commentNode({ id: "ic1", body: "LGTM but…" })])],
		});

		const result = await prCommentsHandlers.getTaskPrComments({ taskId: "t1", projectId: "p1" });
		expect(result?.prNumber).toBe(42);
		expect(result?.prUrl).toBe(task.prUrl);
		expect(result?.threads).toHaveLength(1);
		expect(result?.threads[0].comments[0].author).toBe("alice");
		expect(result?.conversation).toHaveLength(1);
		expect(result?.conversation[0].body).toBe("LGTM but…");
		expect(runGitHub).toHaveBeenCalledTimes(2);
	});

	it("follows pagination cursors", async () => {
		mockGraphQL({
			reviewThreads: [
				graphqlResponse("reviewThreads", [threadNode({ id: "th1" })], true, "CUR1"),
				graphqlResponse("reviewThreads", [threadNode({ id: "th2" })]),
			],
			comments: [graphqlResponse("comments", [])],
		});

		const result = await prCommentsHandlers.getTaskPrComments({ taskId: "t1", projectId: "p1" });
		expect(result?.threads.map((thread) => thread.id)).toEqual(["th1", "th2"]);
		expect(runGitHub).toHaveBeenCalledTimes(3);
	});

	it("serves the cache within the TTL and refetches with force", async () => {
		mockGraphQL({
			reviewThreads: [graphqlResponse("reviewThreads", [threadNode()]), graphqlResponse("reviewThreads", [])],
			comments: [graphqlResponse("comments", []), graphqlResponse("comments", [])],
		});

		const first = await prCommentsHandlers.getTaskPrComments({ taskId: "t1", projectId: "p1" });
		expect(runGitHub).toHaveBeenCalledTimes(2);

		const cached = await prCommentsHandlers.getTaskPrComments({ taskId: "t1", projectId: "p1" });
		expect(cached).toBe(first);
		expect(runGitHub).toHaveBeenCalledTimes(2);

		const forced = await prCommentsHandlers.getTaskPrComments({ taskId: "t1", projectId: "p1", force: true });
		expect(forced?.threads).toHaveLength(0);
		expect(runGitHub).toHaveBeenCalledTimes(4);
	});

	it("throws when GraphQL reports errors", async () => {
		runGitHub.mockResolvedValue({
			ok: true,
			code: 0,
			stderr: "",
			stdout: JSON.stringify({ errors: [{ message: "Field 'reviewThreads' is broken" }] }),
		});
		await expect(prCommentsHandlers.getTaskPrComments({ taskId: "t1", projectId: "p1" }))
			.rejects.toThrow(/broken/);
	});

	it("throws when the gh command fails", async () => {
		runGitHub.mockResolvedValue({ ok: false, code: 1, stderr: "gh: not authenticated", stdout: "" });
		await expect(prCommentsHandlers.getTaskPrComments({ taskId: "t1", projectId: "p1" }))
			.rejects.toThrow(/not authenticated/);
	});
});

describe("sendAgentMessageNow", () => {
	it("delivers the text to the task's live agent", async () => {
		sendMessageImmediately.mockResolvedValue(undefined);
		await prCommentsHandlers.sendAgentMessageNow({ taskId: "t1", projectId: "p1", text: "fix it" });
		expect(sendMessageImmediately).toHaveBeenCalledWith(task, "fix it");
	});

	it("propagates delivery failures", async () => {
		sendMessageImmediately.mockRejectedValue(new Error("no live agent"));
		await expect(prCommentsHandlers.sendAgentMessageNow({ taskId: "t1", projectId: "p1", text: "fix it" }))
			.rejects.toThrow(/no live agent/);
	});
});
