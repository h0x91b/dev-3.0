import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../../shared/types";
import { execFileSync } from "node:child_process";
import { claudeEncodePath } from "../../shared/conversation-search-core";
import { genericAdapter } from "../../shared/agent-adapters/generic";
import { buildCmdScript } from "../rpc-handlers/shared-pure";

const parseConversation = vi.fn();
const runHandoffJob = vi.fn();

vi.mock("../../shared/conversation-parsers", async () => {
	const actual = await vi.importActual<typeof import("../../shared/conversation-parsers")>("../../shared/conversation-parsers");
	parseConversation.mockImplementation(actual.parseConversation);
	return { ...actual, parseConversation: (...args: Parameters<typeof actual.parseConversation>) => parseConversation(...args) };
});

vi.mock("../conversation-handoff-runner", async () => {
	const actual = await vi.importActual<typeof import("../conversation-handoff-runner")>("../conversation-handoff-runner");
	runHandoffJob.mockImplementation(actual.runHandoffJob);
	return { ...actual, runHandoffJob: (...args: Parameters<typeof actual.runHandoffJob>) => runHandoffJob(...args) };
});

const { _resetHandoffPreviewCacheForTests, handoffPrompt, prepareTaskHandoff, previewTaskHandoff } = await import("../conversation-handoff");

function jsonl(...records: unknown[]): string {
	return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

function transcript(prompt: string, sessionId = "sess-1"): string {
	return jsonl(
		{ type: "ai-title", aiTitle: "T", sessionId },
		{
			type: "user", uuid: "u0", sessionId, cwd: "/w", gitBranch: "main",
			timestamp: "2026-08-20T10:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: prompt }] },
		},
		{
			type: "assistant", uuid: "a0", parentUuid: "u0", sessionId,
			timestamp: "2026-08-20T10:00:01.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "done" }] },
		},
	);
}

let container: string;
let home: string;
let task: Task;

/** Write a Claude transcript for the task's worktree with an explicit mtime (seconds). */
function seed(name: string, body: string, mtime: number): string {
	const dir = join(home, ".claude", "projects", claudeEncodePath(task.worktreePath!));
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, body);
	utimesSync(path, mtime, mtime);
	return path;
}

beforeEach(() => {
	container = mkdtempSync(join(tmpdir(), "dev3-handoff-"));
	home = join(container, "home");
	task = { id: "t1", worktreePath: join(container, "worktree") } as Task;
	_resetHandoffPreviewCacheForTests();
	parseConversation.mockClear();
	runHandoffJob.mockClear();
	seed("sess-1.jsonl", transcript("BUILD THE THING"), 1_000);
});

afterEach(() => rmSync(container, { recursive: true, force: true }));

describe("previewTaskHandoff", () => {
	it("describes the conversation a handoff would retell", async () => {
		expect(await previewTaskHandoff(task, { home })).toMatchObject({ source: "claude", sessionId: "sess-1", turns: 1 });
	});

	it("answers null when the task has no worktree, without touching the parser", async () => {
		expect(await previewTaskHandoff({ ...task, worktreePath: null } as Task, { home })).toBeNull();
		expect(runHandoffJob).not.toHaveBeenCalled();
	});

	it("answers null when nothing parseable ran in the worktree", async () => {
		expect(await previewTaskHandoff(task, { home: join(container, "empty-home") })).toBeNull();
	});

	it("goes through the handoff runner, which keeps the parse off the host thread", async () => {
		await previewTaskHandoff(task, { home });
		expect(runHandoffJob).toHaveBeenCalledWith(expect.objectContaining({ kind: "preview", worktreePath: task.worktreePath }), expect.anything());
	});

	it("parses only the newest transcript, not every session the task had", async () => {
		seed("sess-2.jsonl", transcript("OLDER", "sess-2"), 500);
		seed("sess-3.jsonl", transcript("NEWEST", "sess-3"), 2_000);

		expect(await previewTaskHandoff(task, { home })).toMatchObject({ sessionId: "sess-3" });
		expect(parseConversation).toHaveBeenCalledTimes(1);
	});

	it("falls back to the next newest when the newest cannot be read", async () => {
		const unreadable = seed("sess-3.jsonl", transcript("NEWEST", "sess-3"), 2_000);
		chmodSync(unreadable, 0o000);

		expect(await previewTaskHandoff(task, { home })).toMatchObject({ sessionId: "sess-1" });
	});

	it("reopening the dialog reuses the preview until the transcript changes", async () => {
		await previewTaskHandoff(task, { home });
		await previewTaskHandoff(task, { home });
		expect(parseConversation).toHaveBeenCalledTimes(1);

		seed("sess-1.jsonl", transcript("BUILD THE THING") + transcript("MORE"), 1_500);
		expect(await previewTaskHandoff(task, { home })).toMatchObject({ turns: 2 });
		expect(parseConversation).toHaveBeenCalledTimes(2);
	});

	it("shares one scan between opens that overlap", async () => {
		const [a, b] = await Promise.all([previewTaskHandoff(task, { home }), previewTaskHandoff(task, { home })]);
		expect(a).toEqual(b);
		expect(runHandoffJob).toHaveBeenCalledTimes(1);
	});
});

describe("a task whose agent is Cursor Agent", () => {
	/** Cursor cuts long cwds and hash-suffixes the dir, so only `.workspace-trusted` names the worktree. */
	function seedCursor(mtime: number): void {
		const project = join(home, ".cursor", "projects", "Users-x-Docume-28b6597");
		const dir = join(project, "agent-transcripts", "cur-1");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(project, ".workspace-trusted"), JSON.stringify({ workspacePath: task.worktreePath }));
		const path = join(dir, "cur-1.jsonl");
		writeFileSync(path, jsonl(
			{ role: "user", message: { content: [{ type: "text", text: "<user_query>\nCURSOR WORK\n</user_query>" }] } },
			{ role: "assistant", message: { content: [{ type: "text", text: "done" }] } },
		));
		utimesSync(path, mtime, mtime);
	}

	it("offers the Cursor conversation for handoff", async () => {
		seedCursor(2_000);
		expect(await previewTaskHandoff(task, { home })).toMatchObject({ source: "cursor", sessionId: "cur-1", turns: 1 });
	});

	it("retells it under Cursor's name", async () => {
		seedCursor(2_000);
		const prepared = await prepareTaskHandoff(task, { home });
		expect(readFileSync(prepared!.path, "utf-8")).toContain("CURSOR WORK");
		expect(handoffPrompt(prepared!)).toContain("ran in Cursor Agent");
	});
});

describe("handoff in a folder other tasks share", () => {
	const MINE = "11111111-1111-4111-8111-111111111111";
	const THEIRS = "22222222-2222-4222-8222-222222222222";

	beforeEach(() => {
		seed(`${MINE}.jsonl`, transcript("MY WORK", MINE), 1_500);
		seed(`${THEIRS}.jsonl`, transcript("NEIGHBOUR WORK", THEIRS), 3_000);
	});

	it("previews this task's own newest session, not a neighbour's newer one", async () => {
		expect(await previewTaskHandoff(task, { home, sessionIds: [MINE] })).toMatchObject({ sessionId: MINE });
	});

	it("never serves one task's cached preview to another task in the same folder", async () => {
		const other = { ...task, id: "t2" } as Task;
		expect(await previewTaskHandoff(task, { home, sessionIds: [MINE] })).toMatchObject({ sessionId: MINE });
		expect(await previewTaskHandoff(other, { home, sessionIds: [THEIRS] })).toMatchObject({ sessionId: THEIRS });
	});

	it("retells only this task's session", async () => {
		const prepared = await prepareTaskHandoff(task, { home, sessionIds: [MINE] });
		expect(prepared?.sessionId).toBe(MINE);
		expect(readFileSync(prepared!.path, "utf-8")).not.toContain("NEIGHBOUR WORK");
	});

	it("offers nothing when none of the folder's sessions is this task's", async () => {
		expect(await previewTaskHandoff(task, { home, sessionIds: [] })).toBeNull();
	});
});

describe("prepareTaskHandoff", () => {
	it("writes the retelling beside the task's dumps, not inside the worktree", async () => {
		const prepared = await prepareTaskHandoff(task, { home });
		expect(prepared?.path).toBe(join(container, "conversations", "handoff-claude-sess-1.md"));
		// The container outlives the worktree, so a completed task keeps its handoff.
		expect(prepared?.path.startsWith(join(container, "worktree"))).toBe(false);
	});

	it("writes a body that names itself a retelling and carries the request", async () => {
		const prepared = await prepareTaskHandoff(task, { home });
		const body = readFileSync(prepared!.path, "utf-8");
		expect(body).toContain("You are taking over work that ran in Claude Code");
		expect(body).toContain("BUILD THE THING");
		expect(body).toContain("Retold from a claude transcript by dev3");
		expect(prepared?.chars).toBe(body.length);
	});

	it("takes the newest session and renders it through the handoff runner", async () => {
		seed("sess-2.jsonl", transcript("NEWEST", "sess-2"), 9_000);
		const prepared = await prepareTaskHandoff(task, { home });
		expect(readFileSync(prepared!.path, "utf-8")).toContain("NEWEST");
		expect(runHandoffJob).toHaveBeenCalledWith(expect.objectContaining({ kind: "render" }), expect.anything());
	});

	it("returns null rather than writing an empty file when nothing parsed", async () => {
		expect(await prepareTaskHandoff(task, { home: join(container, "empty-home") })).toBeNull();
	});
});

describe("handoffPrompt", () => {
	it("points at the file and denies ownership of everything in it", async () => {
		const prepared = await prepareTaskHandoff(task, { home });
		const prompt = handoffPrompt(prepared!);

		expect(prompt).toContain(prepared!.path);
		expect(prompt).toContain("RETELLING");
		expect(prompt).toContain("You did none of it, and nothing in it is still running.");
		// It is typed into a pane, so it has to stay one short line's worth of text.
		expect(prompt.length).toBeLessThan(1_000);
		expect(prompt).not.toContain("\n");
	});

	it("names the agent the work actually ran in", async () => {
		expect(handoffPrompt({ ...(await prepareTaskHandoff(task, { home }))!, source: "codex" })).toContain("ran in Codex");
	});

	it("is unchanged by an absent or blank instruction", async () => {
		const prepared = (await prepareTaskHandoff(task, { home }))!;
		const plain = handoffPrompt(prepared);

		expect(plain.endsWith("then continue the work from where it stopped.")).toBe(true);
		expect(handoffPrompt(prepared, undefined)).toBe(plain);
		expect(handoffPrompt(prepared, "")).toBe(plain);
		expect(handoffPrompt(prepared, "  \n\t ")).toBe(plain);
	});

	it("keeps the retelling and makes the instruction the next message, verbatim", async () => {
		const prepared = (await prepareTaskHandoff(task, { home }))!;
		const instruction = `Now review the security of the solution.\nDon't edit files — only "propose" a plan for $HOME and \`whoami\`.`;
		const prompt = handoffPrompt(prepared, `\n  ${instruction}  \n`);

		expect(prompt).toContain(prepared.path);
		expect(prompt).toContain("You did none of it, and nothing in it is still running.");
		expect(prompt).not.toContain("continue the work from where it stopped");
		expect(prompt.endsWith(`\n\n${instruction}`)).toBe(true);
	});

	it.skipIf(process.platform === "win32")("reaches the agent's argv byte-identical through a real launch script", async () => {
		const prepared = (await prepareTaskHandoff(task, { home }))!;
		const instruction = `Continue, but only propose a plan.\nNo edits: 'quotes', "doubles", $HOME, \`cmd\`, a && b; \\ end`;
		const expected = handoffPrompt(prepared, instruction);
		const record = join(container, "argv.json");
		const probe = join(container, "probe.sh");
		writeFileSync(probe, `#!/bin/bash\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' ${JSON.stringify(record)} "$@"\n`);
		chmodSync(probe, 0o755);
		const ctx = { taskTitle: "", taskDescription: expected, projectName: "p", projectPath: "/p", worktreePath: task.worktreePath! };
		const script = join(container, "launch.sh");
		writeFileSync(script, buildCmdScript(genericAdapter.launchArgs(probe, undefined, ctx).join(" ")));

		execFileSync("bash", [script], { stdio: "ignore" });

		const argv = JSON.parse(readFileSync(record, "utf8")) as string[];
		expect(argv[argv.length - 1]).toBe(expected);
		expect(argv.filter((arg) => arg.includes(instruction))).toHaveLength(1);
	});
});
