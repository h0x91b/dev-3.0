import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleCursorUsage } from "../commands/cursor-usage";

const payload = {
	hook_event_name: "afterAgentResponse", conversation_id: "conversation-1", generation_id: "generation-1",
	model: "claude-sonnet-4.6", input_tokens: 300, output_tokens: 50,
	cache_read_tokens: 200, cache_write_tokens: 100,
	text: "Private conversation content", user_email: "private@example.com", transcript_path: "/private/path",
};

describe("Cursor usage CLI adapter", () => {
	let root: string;
	beforeEach(() => { root = mkdtempSync(join(tmpdir(), "dev3-cursor-cli-")); });
	afterEach(() => { rmSync(root, { recursive: true, force: true }); });

	it("persists an allowlisted usage record without retaining conversation text", () => {
		handleCursorUsage(JSON.stringify(payload), root);
		const text = readFileSync(join(root, "usage", "cursor.jsonl"), "utf8");
		const { record } = JSON.parse(text);
		expect({ counts: record.counts, privateDataPresent: /Private conversation|private@example|private\/path/.test(text) }).toEqual({
			counts: { inputTokens: 300, outputTokens: 50, cacheReadInputTokens: 200, cacheCreationInputTokens: 100 },
			privateDataPresent: false,
		});
	});

	it.each(["", "null", "{incomplete", JSON.stringify({ text: "Private" })])("ignores unsupported input %j", (input) => {
		handleCursorUsage(input, root);
		expect(existsSync(join(root, "usage", "cursor.jsonl"))).toBe(false);
	});

	it("remains successful when storage cannot be created", () => {
		const blocker = join(root, "file-not-directory");
		writeFileSync(blocker, "blocked");
		expect(() => handleCursorUsage(JSON.stringify(payload), blocker)).not.toThrow();
	});

	it("runs the hidden hook without an app or task context and produces no output", () => {
		const result = spawnSync("bun", [resolve(__dirname, "../main.ts"), "hook", "cursor-usage"], {
			cwd: root, input: JSON.stringify(payload), encoding: "utf8", timeout: 15_000,
			env: { ...process.env, DEV3_HOME: root, DEV3_CLI_SOCKET: join(root, "offline.sock"), DEV3_TASK_ID: "" },
		});
		expect({ code: result.status, stdout: result.stdout, stderr: result.stderr, recorded: existsSync(join(root, "usage", "cursor.jsonl")) }).toEqual({
			code: 0, stdout: "", stderr: "", recorded: true,
		});
	});
});
