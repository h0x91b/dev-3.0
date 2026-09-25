import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditHarnessManifest } from "../harness-audit";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "harness-audit-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function file(name: string, entries: unknown[]) {
	writeFileSync(join(dir, name), entries.map((entry) => JSON.stringify(entry)).join("\n"));
	return name;
}
function context(model: string) { return { type: "turn_context", payload: { model } }; }
function native(id: string, input = 1_000_000, cached = 0, writes = 0, output = 0) {
	return { type: "token_usage_record", payload: { response_id: id, usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: writes, output_tokens: output } } };
}
function legacy(input: number, cumulative: number) {
	return { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: input, output_tokens: 0 }, total_token_usage: { input_tokens: cumulative, output_tokens: 0 } } } };
}
function claude(id: string, usage: Record<string, unknown>, model = "claude-sonnet-4-6") {
	return { type: "assistant", requestId: `request-${id}`, message: { id, model, usage, content: [{ type: "text", text: "private assistant output" }] } };
}
function task(path: string, source: "codex" | "claude" = "codex", completed = true, id = "private-task-id") {
	return { id, completed, transcripts: [{ path, source, role: "parent" as const }] };
}

describe("auditHarnessManifest", () => {
	it("splits inclusive native input into normal input, reads, writes, and output without counting both streams", () => {
		const duplicate = legacy(1_000_000, 1_000_000);
		Object.assign(duplicate.payload.info.total_token_usage, { cached_input_tokens: 500_000, cache_write_input_tokens: 100_000, output_tokens: 1_000_000 });
		const path = file("native.jsonl", [context("gpt-6-astra"), duplicate, native("response-secret", 1_000_000, 500_000, 100_000, 1_000_000)]);
		const report = auditHarnessManifest({ tasks: [task(path)] }, dir);
		expect(report).toMatchObject({ suppliedUsageAccounted: true, usageRecords: 1, cacheTokenShare: 0.5, requestCacheHitShare: 1,
			knownCostUsd: { input: 4, cacheRead: 0.5, cacheWrite5m: 1.25, output: 50, total: 55.75 },
			tasks: [{ requests: [{ tokens: { input: 400_000, cacheRead: 500_000, cacheWrite5m: 100_000, output: 1_000_000 } }], transcripts: [{ ignoredLegacyRecords: 1 }] }],
		});
	});

	it("marks historical legacy spend incomplete when a resumed file starts emitting native records", () => {
		const path = file("upgraded.jsonl", [context("gpt-6-astra"), legacy(99_000_000, 99_000_000), native("new-response")]);
		expect(auditHarnessManifest({ tasks: [task(path)] }, dir)).toMatchObject({
			suppliedUsageAccounted: false, usageRecords: 1, knownCostUsd: { total: 10 }, totalCostUsd: null,
			apiEquivalentCostPerCompletedTaskUsd: null,
		});
	});

	it("replaces native response snapshots and prices each model separately", () => {
		const path = file("mixed.jsonl", [context("gpt-6-astra"), native("one", 10), native("one", 1_000_000), context("gpt-6-sol"), native("two")]);
		expect(auditHarnessManifest({ tasks: [task(path)] }, dir)).toMatchObject({ usageRecords: 2, totalCostUsd: 12, tasks: [{ transcripts: [{ duplicateUsageRecords: 1 }] }] });
	});

	it("replaces Claude snapshots and prices a mixed partial/unsplit cache remainder", () => {
		const path = file("claude.jsonl", [
			claude("one", { input_tokens: 0, output_tokens: 100 }),
			claude("one", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 2_000_000, cache_creation: { ephemeral_1h_input_tokens: 500_000 } }),
			claude("two", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 }),
		]);
		expect(auditHarnessManifest({ tasks: [task(path, "claude")] }, dir)).toMatchObject({ usageRecords: 2, totalCostUsd: 12.375, tokens: { cacheWrite5m: 2_500_000, cacheWrite1h: 500_000 } });
	});

	it("includes parent, child, and unfinished attempts over only completed tasks", () => {
		const parent = file("parent.jsonl", [context("gpt-6-astra"), native("one")]);
		const child = file("child.jsonl", [context("gpt-6-sol"), native("two")]);
		const failed = file("failed.jsonl", [context("gpt-6-astra"), native("three")]);
		const completed = task(parent);
		const report = auditHarnessManifest({ tasks: [{ ...completed, transcripts: [...completed.transcripts, { path: child, source: "codex", role: "subagent" }] }, task(failed, "codex", false, "failed")] }, dir);
		expect(report).toMatchObject({ taskCount: 2, completedTasks: 1, apiEquivalentCostPerCompletedTaskUsd: 22, costByRole: { parent: { total: 20 }, subagent: { total: 2 } } });
	});

	it("keeps repeated legacy cumulative totals from adding the same delta twice and marks the estimate incomplete", () => {
		const path = file("legacy.jsonl", [context("gpt-6-astra"), legacy(1_000_000, 1_000_000), legacy(1_000_000, 1_000_000), legacy(500_000, 1_500_000)]);
		expect(auditHarnessManifest({ tasks: [task(path)] }, dir)).toMatchObject({ suppliedUsageAccounted: false, usageRecords: 2, identifiedRequestRecords: 0, legacyUsageRecords: 2, knownCostUsd: { total: 15 }, totalCostUsd: null, requestCacheHitShare: null, apiEquivalentCostPerCompletedTaskUsd: null });
	});

	it("does not treat unpriced and incomplete usage as free", () => {
		const path = file("incomplete.jsonl", [context("mystery-model"), native("one"), context("gpt-6-astra"), { type: "token_usage_record", payload: { response_id: "two", usage: { input_tokens: 1_000_000 } } }]);
		expect(auditHarnessManifest({ tasks: [task(path)] }, dir)).toMatchObject({ suppliedUsageAccounted: false, unpricedRecords: 1, incompleteRecords: 2, knownCostUsd: { total: 10 }, totalCostUsd: null, tasks: [{ requests: [{ costUsd: null }, { gaps: ["Missing or invalid output_tokens."] }] }] });
	});

	it("reports zero completed tasks with a null denominator", () => {
		const path = file("unfinished.jsonl", [context("gpt-6-astra"), native("one")]);
		expect(auditHarnessManifest({ tasks: [task(path, "codex", false)] }, dir)).toMatchObject({ completedTasks: 0, knownCostUsd: { total: 10 }, apiEquivalentCostPerCompletedTaskUsd: null, knownCostPerCompletedTaskUsd: null });
	});

	it("marks impossible billing counters incomplete instead of claiming an exact total", () => {
		const path = file("impossible.jsonl", [context("gpt-6-astra"), native("one", 10, 20), native("two", -1)]);
		expect(auditHarnessManifest({ tasks: [task(path)] }, dir)).toMatchObject({ suppliedUsageAccounted: false, totalCostUsd: null, incompleteRecords: 2 });
	});

	it("deduplicates overlapping request snapshots within one task", () => {
		const first = file("first.jsonl", [context("gpt-6-astra"), native("one", 100)]);
		const second = file("second.jsonl", [context("gpt-6-astra"), native("one", 1_000_000)]);
		const spec = task(first);
		expect(auditHarnessManifest({ tasks: [{ ...spec, transcripts: [...spec.transcripts, { path: second, source: "codex", role: "parent" }] }] }, dir)).toMatchObject({ usageRecords: 1, totalCostUsd: 10, tasks: [{ duplicateUsageRecords: 1 }] });
	});

	it("rejects a request attributed to both a parent and a child", () => {
		const first = file("first.jsonl", [context("gpt-6-astra"), native("one", 100)]);
		const second = file("second.jsonl", [context("gpt-6-astra"), native("one", 1_000_000)]);
		const spec = task(first);
		expect(() => auditHarnessManifest({ tasks: [{ ...spec, transcripts: [...spec.transcripts, { path: second, source: "codex", role: "subagent" }] }] }, dir)).toThrow("attributes one usage request to both parent and subagent");
	});

	it("reports malformed lines, empty files, and tasks with no transcript coverage", () => {
		writeFileSync(join(dir, "broken.jsonl"), `${JSON.stringify(context("gpt-6-astra"))}\n${JSON.stringify(native("one"))}\n{broken`);
		const empty = file("empty.jsonl", []);
		const report = auditHarnessManifest({ tasks: [task("broken.jsonl"), task(empty, "codex", true, "empty"), { id: "absent", completed: true, transcripts: [] }] }, dir);
		expect(report).toMatchObject({ suppliedUsageAccounted: false, totalCostUsd: null, tasks: [{ transcripts: [{ invalidLines: 1 }] }, { suppliedUsageAccounted: false, transcripts: [{ gaps: ["Empty transcript."] }] }, { suppliedUsageAccounted: false, usageRecords: 0 }] });
	});

	it("counts tool activity without leaking content, paths, native ids, or task ids", () => {
		const path = file("sensitive-name.jsonl", [context("gpt-6-astra"), native("secret-response-id"),
			{ type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "secret-call-id", arguments: '{"cmd":"private command"}' } },
			{ type: "response_item", payload: { type: "function_call_output", call_id: "secret-call-id", output: "private output" } },
		]);
		const report = auditHarnessManifest({ tasks: [task(path)] }, dir);
		expect(report.tasks[0].transcripts[0].tools).toMatchObject({ toolCalls: 1, toolResults: 1, toolOutputCharacters: 14, toolOutputBytes: 14 });
		expect(JSON.stringify(report)).not.toMatch(/sensitive-name|secret-response-id|secret-call-id|private command|private output|private-task-id|harness-audit-/);
	});

	it("rejects duplicate task identities without exposing them", () => {
		expect(() => auditHarnessManifest({ tasks: [task("one"), task("two")] }, dir)).toThrow("Task 2 repeats a task id");
	});

	it("rejects shared files, including symlink aliases", () => {
		const path = file("one.jsonl", [context("gpt-6-astra"), native("one")]);
		symlinkSync(dir, join(dir, "alias"), "junction");
		expect(() => auditHarnessManifest({ tasks: [task(path), task("alias/one.jsonl", "codex", true, "second")] }, dir)).toThrow("repeats a file already assigned to task 1");
	});

	it("rejects copied transcript files across tasks", () => {
		const entries = [context("gpt-6-astra"), native("one")];
		const first = file("one.jsonl", entries);
		const second = file("two.jsonl", entries);
		expect(() => auditHarnessManifest({ tasks: [task(first), task(second, "codex", true, "second")] }, dir)).toThrow("duplicates transcript content assigned to task 1");
	});

	it("rejects partial request overlap attributed to different tasks", () => {
		const first = file("one.jsonl", [context("gpt-6-astra"), native("one")]);
		const second = file("two.jsonl", [context("gpt-6-astra"), native("one"), native("two")]);
		expect(() => auditHarnessManifest({ tasks: [task(first), task(second, "codex", true, "second")] }, dir)).toThrow("shares a usage request with task 1");
	});

	it("rejects unreadable files without including their paths", () => {
		expect(() => auditHarnessManifest({ tasks: [task("private-missing-file")] }, dir)).toThrow("Cannot read task 1, transcript 1; check the manifest path and permissions.");
	});
});
