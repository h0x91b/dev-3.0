import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../context";

vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));

import { sendRequest } from "../socket-client";
import { agyAccountKey, agyDumpPath, handleAgyStatusLine } from "../commands/agy-statusline";

const mockSend = vi.mocked(sendRequest);
const SOCKET = "/tmp/test.sock";
const CONTEXT: CliContext = { projectId: "project-1", taskId: "task-1", socketPath: SOCKET };
const NOW = 1_800_000_000_000;
const QUOTA = { "gemini-weekly": { remaining_fraction: 0.75, reset_time: "2026-11-23T10:00:00Z", reset_in_seconds: 259200 } };

let home: string;
let stdout = "";
let stderr = "";
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let originalTmuxPane: string | undefined;

const payload = (extra: Record<string, unknown> = {}) =>
	JSON.stringify({ email: "me@example.com", plan_tier: "Pro", model: "m", quota: QUOTA, ...extra });

const run = (raw: string, options = { noLimits: false }, context: CliContext | null = CONTEXT, now = NOW) =>
	handleAgyStatusLine(raw, options, SOCKET, context, now, home);

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dev3-agy-statusline-"));
	stdout = "";
	stderr = "";
	originalTmuxPane = process.env.TMUX_PANE;
	delete process.env.TMUX_PANE;
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdout += String(chunk);
		return true;
	});
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	});
	mockSend.mockReset();
	mockSend.mockResolvedValue({ id: "1", ok: true, data: {} });
});

afterEach(() => {
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
	else process.env.TMUX_PANE = originalTmuxPane;
	rmSync(home, { recursive: true, force: true });
});

describe("agy statusline: the quota dump", () => {
	it("writes one dump per account, named by a hash of the email and never by the email", async () => {
		await run(payload());

		const file = agyDumpPath("me@example.com", home);
		expect(file).toContain(agyAccountKey("me@example.com"));
		expect(file).not.toContain("example.com");
		expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ capturedAt: NOW, email: "me@example.com", planTier: "Pro", quota: QUOTA });
		expect(agyAccountKey("me@example.com")).not.toBe(agyAccountKey("other@example.com"));
	});

	it("keeps accounts apart", async () => {
		await run(payload());
		await run(payload({ email: "other@example.com" }));
		expect(readdirSync(join(home, "data", "rate-limits", "agy"))).toHaveLength(2);
	});

	it("does not rewrite the same reading within the refresh window, but does once it changed or aged", async () => {
		await run(payload());
		await run(payload(), { noLimits: false }, CONTEXT, NOW + 10_000);
		expect(JSON.parse(readFileSync(agyDumpPath("me@example.com", home), "utf-8")).capturedAt).toBe(NOW);

		await run(payload(), { noLimits: false }, CONTEXT, NOW + 60_000);
		expect(JSON.parse(readFileSync(agyDumpPath("me@example.com", home), "utf-8")).capturedAt).toBe(NOW + 60_000);

		await run(payload({ quota: { "gemini-weekly": { remaining_fraction: 0.5 } } }), { noLimits: false }, CONTEXT, NOW + 61_000);
		expect(JSON.parse(readFileSync(agyDumpPath("me@example.com", home), "utf-8")).quota["gemini-weekly"].remaining_fraction).toBe(0.5);
	});

	it("never lets a payload without a quota overwrite the last good dump", async () => {
		const REAL = {
			"gemini-5h": { remaining_fraction: 0.25, reset_time: "2026-11-20T13:00:00Z", reset_in_seconds: 10800 },
			"gemini-weekly": { remaining_fraction: 0.6, reset_time: "2026-11-26T10:00:00Z", reset_in_seconds: 518400 },
			"3p-5h": { remaining_fraction: 1, reset_time: "2026-11-20T15:00:00Z", reset_in_seconds: 18000 },
			"3p-weekly": { remaining_fraction: 0.9, reset_time: "2026-11-27T10:00:00Z", reset_in_seconds: 604800 },
		};
		await run(payload({ quota: REAL, plan_tier: "Google AI Ultra" }));
		// The first payload of a new conversation: no quota, no plan_tier, only state.
		const early = JSON.stringify({ agent_state: "idle", model: "m", workspace: { current_dir: "/w" }, email: "me@example.com" });
		await run(early, { noLimits: false }, CONTEXT, NOW + 120_000);

		const dump = JSON.parse(readFileSync(agyDumpPath("me@example.com", home), "utf-8"));
		expect(dump.capturedAt).toBe(NOW);
		expect(dump.planTier).toBe("Google AI Ultra");
		expect(Object.keys(dump.quota)).toEqual(["gemini-5h", "gemini-weekly", "3p-5h", "3p-weekly"]);
	});

	it("writes nothing while rate-limit tracking is off, or when no bucket has a fraction", async () => {
		await run(payload(), { noLimits: true });
		await run(payload({ quota: { a: { remaining_amount: 5 } } }));
		expect(existsSync(join(home, "data", "rate-limits"))).toBe(false);
	});

	it("dumps with no task around it, and never prints anything", async () => {
		await run(payload(), { noLimits: false }, null);
		expect(existsSync(agyDumpPath("me@example.com", home))).toBe(true);
		expect(mockSend).not.toHaveBeenCalled();
		expect(stdout).toBe("");
		expect(stderr).toBe("");
	});
});

describe("agy statusline: the task's state", () => {
	it("sends a pending tool confirmation once, as a permission wait", async () => {
		process.env.TMUX_PANE = "%7";
		await run(payload({ tool_confirmation_pending: true, conversation_id: "conv-1" }));
		await run(payload({ tool_confirmation_pending: true, conversation_id: "conv-1" }));

		const events = mockSend.mock.calls.map((call) => ({ method: call[1], event: (call[2] as Record<string, unknown>).event, captureOnly: (call[2] as Record<string, unknown>).captureOnly }));
		expect(events).toEqual([
			{ method: "task.agentHook", event: "PermissionRequest", captureOnly: undefined },
			{ method: "task.agentHook", event: "SessionStart", captureOnly: true },
		]);
		expect(mockSend.mock.calls[0]![2]).toMatchObject({ taskId: "task-1", harness: "agy", sessionId: "conv-1", paneId: "%7" });
	});

	it("hands the task back once the confirmation is answered, and only then", async () => {
		await run(payload());
		expect(mockSend).not.toHaveBeenCalled();

		await run(payload({ tool_confirmation_pending: true }));
		await run(payload({ tool_confirmation_pending: false }));
		await run(payload({ tool_confirmation_pending: false }));

		expect(mockSend.mock.calls.map((call) => (call[2] as Record<string, unknown>).event)).toEqual(["PermissionRequest", "PostToolUse"]);
	});

	it("records an unseen conversation id without moving the task, and again after a new conversation", async () => {
		await run(payload({ conversation_id: "conv-1" }));
		await run(payload({ conversation_id: "conv-1" }));
		await run(payload({ conversation_id: "conv-2" }));

		expect(mockSend.mock.calls.map((call) => (call[2] as Record<string, unknown>).sessionId)).toEqual(["conv-1", "conv-2"]);
		for (const call of mockSend.mock.calls) expect(call[2]).toMatchObject({ event: "SessionStart", captureOnly: true });
	});

	it("keeps each task's state apart", async () => {
		await run(payload({ tool_confirmation_pending: true }));
		await run(payload({ tool_confirmation_pending: true }), { noLimits: false }, { ...CONTEXT, taskId: "task-2" });
		expect(mockSend).toHaveBeenCalledTimes(2);
	});
});

describe("agy statusline: never loud", () => {
	it.each(["", "not json", "null", "[]", "42"])("prints nothing and throws nothing for %j", async (raw) => {
		await expect(run(raw)).resolves.toBeUndefined();
		expect(stdout).toBe("");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("survives a socket that rejects, and an unusable home", async () => {
		mockSend.mockRejectedValue(new Error("socket gone"));
		await expect(run(payload({ tool_confirmation_pending: true }))).resolves.toBeUndefined();
		mockSend.mockResolvedValue({ id: "1", ok: false, error: "task not found" });
		await expect(run(payload({ tool_confirmation_pending: false }))).resolves.toBeUndefined();
		await expect(handleAgyStatusLine(payload(), { noLimits: false }, SOCKET, CONTEXT, NOW, "/proc/definitely/not/writable")).resolves.toBeUndefined();
		expect(stdout).toBe("");
	});
});
