import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexTurnWatches, codexTurnEndError, type CodexTurnFailure } from "../codex-turn-watch";

const ERROR = "unexpected status 403 Forbidden: This reasoning level isn't available for the selected model in your workspace.";
const record = (payload: object) => `${JSON.stringify({ timestamp: "t", type: "event_msg", payload })}\n`;
const failed = record({ type: "task_complete", turn_id: "t1", last_agent_message: null, error: { message: ERROR } });
const finished = record({ type: "task_complete", turn_id: "t1", last_agent_message: "done" });

const roots: string[] = [];
const watchers: CodexTurnWatches[] = [];
afterEach(() => {
	for (const watcher of watchers.splice(0)) watcher.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(existing = "") {
	const directory = mkdtempSync(join(tmpdir(), "codex-turn-"));
	roots.push(directory);
	const transcriptPath = join(directory, "rollout.jsonl");
	writeFileSync(transcriptPath, existing);
	const onFailure = vi.fn(async (_failure: CodexTurnFailure) => {});
	const watcher = new CodexTurnWatches();
	watchers.push(watcher);
	const input = { projectId: "project", taskId: "task", sessionId: "session", transcriptPath };
	watcher.observe(input, onFailure);
	const check = () => watcher.check("task", "session");
	return { transcriptPath, onFailure, watcher, check };
}

describe("codexTurnEndError", () => {
	it("tells an errored turn end from a clean one and from everything else", () => {
		expect(codexTurnEndError(failed)).toBe(ERROR);
		expect(codexTurnEndError(finished)).toBeNull();
		expect(codexTurnEndError(record({ type: "turn_aborted", reason: "interrupted" }))).toBeNull();
		expect(codexTurnEndError(record({ type: "token_count" }))).toBeUndefined();
		expect(codexTurnEndError("{not json")).toBeUndefined();
	});
});

describe("Codex turn rollout watch", () => {
	it("reports a turn that ended on an API error, once", async () => {
		const { transcriptPath, onFailure, check } = fixture();
		appendFileSync(transcriptPath, record({ type: "task_started" }) + failed);
		await check();
		appendFileSync(transcriptPath, failed);
		await check();
		expect(onFailure).toHaveBeenCalledTimes(1);
		expect(onFailure.mock.calls[0]![0]).toMatchObject({ taskId: "task", sessionId: "session", message: ERROR });
	});

	it("ignores errors written before the turn started", async () => {
		const { transcriptPath, onFailure, check } = fixture(failed);
		appendFileSync(transcriptPath, record({ type: "token_count" }));
		await check();
		expect(onFailure).not.toHaveBeenCalled();
	});

	it("stops after a clean turn end", async () => {
		const { transcriptPath, onFailure, check } = fixture();
		appendFileSync(transcriptPath, finished);
		await check();
		appendFileSync(transcriptPath, failed);
		await check();
		expect(onFailure).not.toHaveBeenCalled();
	});

	it("joins a record split across two writes", async () => {
		const { transcriptPath, onFailure, check } = fixture();
		appendFileSync(transcriptPath, failed.slice(0, 40));
		await check();
		appendFileSync(transcriptPath, failed.slice(40));
		await check();
		expect(onFailure).toHaveBeenCalledTimes(1);
	});

	it("watches a rollout Codex has not created yet from its start", async () => {
		const { transcriptPath, onFailure, watcher } = fixture();
		const missing = `${transcriptPath}.new`;
		watcher.observe({ projectId: "project", taskId: "task", sessionId: "fresh", transcriptPath: missing }, onFailure);
		await watcher.check("task", "fresh");
		writeFileSync(missing, failed);
		await watcher.check("task", "fresh");
		expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "fresh", message: ERROR }));
	});

	it("reports nothing once the Stop hook ended the turn", async () => {
		const { transcriptPath, onFailure, watcher, check } = fixture();
		watcher.endTurn("task", "session");
		appendFileSync(transcriptPath, failed);
		await check();
		expect(onFailure).not.toHaveBeenCalled();
	});
});
