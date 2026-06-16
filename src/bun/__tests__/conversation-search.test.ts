import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchConversations, type EngineTask } from "../conversation-search";
import { claudeEncodePath, reconstructWorktreePath } from "../../shared/conversation-search-core";

const SLUG = "test-proj";

let home: string;
let dev3Home: string;

function seedTranscript(taskId: string, lines: string[]): void {
	const wt = reconstructWorktreePath(dev3Home, SLUG, taskId);
	const dir = join(home, ".claude", "projects", claudeEncodePath(wt));
	mkdirSync(dir, { recursive: true });
	const jsonl = lines
		.map((text) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }))
		.join("\n");
	writeFileSync(join(dir, "session.jsonl"), jsonl + "\n");
}

function seedCodexRollout(taskId: string, messages: Array<{ role: "user" | "assistant"; text: string }>): void {
	const cwd = reconstructWorktreePath(dev3Home, SLUG, taskId);
	const dir = join(home, ".codex", "sessions", "2026", "01", "01");
	mkdirSync(dir, { recursive: true });
	const lines = [
		JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: { id: taskId, cwd } }),
		...messages.map((m) =>
			JSON.stringify({
				type: "response_item",
				payload: { type: "message", role: m.role, content: [{ type: m.role === "user" ? "input_text" : "output_text", text: m.text }] },
			}),
		),
	];
	writeFileSync(join(dir, `rollout-${taskId}.jsonl`), lines.join("\n") + "\n");
}

function seedGeminiChat(taskId: string, alias: string, messages: Array<{ type: string; text: string }>): void {
	const projectRoot = reconstructWorktreePath(dev3Home, SLUG, taskId);
	const aliasDir = join(home, ".gemini", "tmp", alias);
	mkdirSync(join(aliasDir, "chats"), { recursive: true });
	writeFileSync(join(aliasDir, ".project_root"), projectRoot);
	writeFileSync(
		join(aliasDir, "chats", "session-x.json"),
		JSON.stringify({ messages: messages.map((m) => ({ type: m.type, content: [{ text: m.text }] })) }),
	);
}

function task(id: string, over: Partial<EngineTask> = {}): EngineTask {
	return { id, title: id, description: "", status: "completed", groupId: null, agentId: "builtin-claude", ...over };
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "convsearch-"));
	dev3Home = join(home, ".dev3.0");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("searchConversations", () => {
	it("finds a matching terminal task and returns a snippet", () => {
		const tasks = [task("aaaaaaaa-1"), task("bbbbbbbb-2")];
		seedTranscript("aaaaaaaa-1", ["We fixed the websocket reconnect loop in the transport layer."]);
		seedTranscript("bbbbbbbb-2", ["Unrelated work about CSS tokens."]);

		const results = searchConversations({
			query: "websocket reconnect",
			tasks,
			projectSlug: SLUG,
			currentTaskId: null,
			currentGroupId: null,
			home,
			dev3Home,
		});

		expect(results).toHaveLength(1);
		expect(results[0].taskId).toBe("aaaaaaaa-1");
		expect(results[0].snippets[0]).toContain("websocket");
		expect(results[0].transcriptPaths).toHaveLength(1);
	});

	it("excludes the current task and all same-group siblings", () => {
		const tasks = [
			task("self0000-x", { groupId: "grp" }),
			task("sibl0000-y", { groupId: "grp" }),
			task("othr0000-z", { groupId: null }),
		];
		// All three strongly match — only the non-sibling should survive.
		seedTranscript("self0000-x", ["websocket websocket websocket"]);
		seedTranscript("sibl0000-y", ["websocket websocket websocket"]);
		seedTranscript("othr0000-z", ["websocket websocket"]);

		const results = searchConversations({
			query: "websocket",
			tasks,
			projectSlug: SLUG,
			currentTaskId: "self0000-x",
			currentGroupId: "grp",
			home,
			dev3Home,
		});

		expect(results.map((r) => r.taskId)).toEqual(["othr0000-z"]);
	});

	it("searches only terminal statuses by default, but --all-statuses widens it", () => {
		const tasks = [task("live0000-a", { status: "in-progress" })];
		seedTranscript("live0000-a", ["websocket reconnect logic"]);

		const def = searchConversations({
			query: "websocket",
			tasks,
			projectSlug: SLUG,
			currentTaskId: null,
			currentGroupId: null,
			home,
			dev3Home,
		});
		expect(def).toHaveLength(0);

		const all = searchConversations({
			query: "websocket",
			tasks,
			projectSlug: SLUG,
			currentTaskId: null,
			currentGroupId: null,
			statuses: ["todo", "in-progress", "completed", "cancelled"],
			home,
			dev3Home,
		});
		expect(all.map((r) => r.taskId)).toEqual(["live0000-a"]);
	});

	it("respects the limit", () => {
		const tasks = [task("t1111111-a"), task("t2222222-b"), task("t3333333-c")];
		seedTranscript("t1111111-a", ["alpha alpha alpha"]);
		seedTranscript("t2222222-b", ["alpha alpha"]);
		seedTranscript("t3333333-c", ["alpha"]);

		const results = searchConversations({
			query: "alpha",
			tasks,
			projectSlug: SLUG,
			currentTaskId: null,
			currentGroupId: null,
			limit: 2,
			home,
			dev3Home,
		});
		expect(results).toHaveLength(2);
		expect(results[0].taskId).toBe("t1111111-a");
	});

	it("matches a task by its notes/overview even with no transcript on disk", () => {
		const tasks = [
			task("notes000-a", { notes: ["Root cause was a websocket heartbeat timeout in the proxy."] }),
			task("over0000-b", { overview: "Refactored the websocket transport layer." }),
		];
		// Deliberately seed NO transcript files.
		const results = searchConversations({
			query: "websocket",
			tasks,
			projectSlug: SLUG,
			currentTaskId: null,
			currentGroupId: null,
			home,
			dev3Home,
		});

		expect(results.map((r) => r.taskId).sort()).toEqual(["notes000-a", "over0000-b"]);
		// The leading snippet comes from the curated meta text.
		expect(results.find((r) => r.taskId === "notes000-a")?.snippets[0]).toContain("websocket");
		expect(results.every((r) => r.transcriptPaths.length === 0)).toBe(true);
	});

	it("finds a match in a codex rollout (cwd from the session header)", () => {
		const tasks = [task("codex000-a", { agentId: "builtin-codex" })];
		seedCodexRollout("codex000-a", [
			{ role: "user", text: "please debug the kafka consumer lag" },
			{ role: "assistant", text: "The kafka consumer lag was caused by a rebalance storm." },
		]);

		const results = searchConversations({
			query: "kafka consumer lag",
			tasks,
			projectSlug: SLUG,
			currentTaskId: null,
			currentGroupId: null,
			home,
			dev3Home,
		});

		expect(results.map((r) => r.taskId)).toEqual(["codex000-a"]);
		expect(results[0].snippets.join(" ")).toContain("kafka");
		expect(results[0].transcriptPaths[0]).toContain(".codex/sessions");
	});

	it("finds a match in a gemini chat (cwd from .project_root)", () => {
		const tasks = [task("gem00000-a", { agentId: "builtin-gemini" })];
		seedGeminiChat("gem00000-a", "worktree-7", [
			{ type: "user", text: "how do we throttle the webhook retries" },
			{ type: "gemini", text: "Add exponential backoff to the webhook retry queue." },
		]);

		const results = searchConversations({
			query: "webhook retries backoff",
			tasks,
			projectSlug: SLUG,
			currentTaskId: null,
			currentGroupId: null,
			home,
			dev3Home,
		});

		expect(results.map((r) => r.taskId)).toEqual(["gem00000-a"]);
		expect(results[0].snippets.join(" ").toLowerCase()).toContain("webhook");
		expect(results[0].transcriptPaths[0]).toContain(".gemini/tmp");
	});

	it("matches a task by a historical (renamed-away) title or overview", () => {
		const tasks = [
			task("hist0000-a", {
				title: "Current unrelated title",
				historyTexts: ["Investigate kafka rebalance storm", "old overview about consumer lag"],
			}),
		];
		const results = searchConversations({
			query: "kafka rebalance",
			tasks,
			projectSlug: SLUG,
			currentTaskId: null,
			currentGroupId: null,
			home,
			dev3Home,
		});
		expect(results.map((r) => r.taskId)).toEqual(["hist0000-a"]);
		expect(results[0].snippets[0].toLowerCase()).toContain("kafka");
	});

	it("returns nothing for an empty query", () => {
		expect(
			searchConversations({
				query: "   ",
				tasks: [task("aaaaaaaa-1")],
				projectSlug: SLUG,
				currentTaskId: null,
				currentGroupId: null,
				home,
				dev3Home,
			}),
		).toEqual([]);
	});
});
