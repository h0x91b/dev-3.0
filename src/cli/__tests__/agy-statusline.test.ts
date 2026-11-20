import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../context";

vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));

import { sendRequest } from "../socket-client";
import { agyDev3Home, agyStatuslineTaskDir } from "../../shared/agy-statusline-state";
import { resolveAccountHome } from "../../shared/user-home";
import { agyAccountKey, agyDumpPath, handleAgyStatusLine } from "../commands/agy-statusline";
import { handleAgyHook } from "../commands/agy-hook";

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
let originalNativePane: string | undefined;

const payload = (extra: Record<string, unknown> = {}) =>
	JSON.stringify({ email: "me@example.com", plan_tier: "Pro", model: "m", quota: QUOTA, ...extra });

const run = (raw: string, options = { noLimits: false }, context: CliContext | null = CONTEXT, now = NOW) =>
	handleAgyStatusLine(raw, options, SOCKET, context, now, home);

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dev3-agy-statusline-"));
	stdout = "";
	stderr = "";
	originalTmuxPane = process.env.TMUX_PANE;
	originalNativePane = process.env.DEV3_PANE_ID;
	process.env.TMUX_PANE = "%1";
	delete process.env.DEV3_PANE_ID;
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
	if (originalNativePane === undefined) delete process.env.DEV3_PANE_ID;
	else process.env.DEV3_PANE_ID = originalNativePane;
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

	it("does not treat the reset countdown as a change: only the fraction left and the reset instant are compared", async () => {
		const bucket = (seconds: number) => ({ "gemini-5h": { remaining_fraction: 0.25, reset_time: "2026-11-20T13:00:00Z", reset_in_seconds: seconds } });
		await run(payload({ quota: bucket(10800) }));
		await run(payload({ quota: bucket(10790) }), { noLimits: false }, CONTEXT, NOW + 10_000);
		const dump = JSON.parse(readFileSync(agyDumpPath("me@example.com", home), "utf-8"));
		expect(dump.capturedAt).toBe(NOW);
		expect(dump.quota["gemini-5h"].reset_in_seconds).toBe(10800);
	});

	it("merges a reading into the last dump bucket by bucket instead of replacing the dump", async () => {
		await run(payload({
			quota: {
				"gemini-5h": { remaining_fraction: 0.25, reset_time: "2026-11-20T13:00:00Z", reset_in_seconds: 10800 },
				"3p-5h": { remaining_fraction: 1, reset_time: "2026-11-20T15:00:00Z", reset_in_seconds: 18000 },
			},
		}));
		await run(payload({ quota: { "gemini-5h": { remaining_fraction: 0.2, reset_time: "2026-11-20T13:00:00Z", reset_in_seconds: 10000 } } }), { noLimits: false }, CONTEXT, NOW + 1_000);

		const dump = JSON.parse(readFileSync(agyDumpPath("me@example.com", home), "utf-8"));
		expect(dump.quota["gemini-5h"].remaining_fraction).toBe(0.2);
		expect(dump.quota["3p-5h"].remaining_fraction).toBe(1);
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

describe("agy statusline: panes of one task", () => {
	const events = () => mockSend.mock.calls.map((call) => [(call[2] as Record<string, unknown>).event, (call[2] as Record<string, unknown>).paneId]);

	it("reports each pane's wait on its own: two panes pending are two permission requests", async () => {
		process.env.TMUX_PANE = "%1";
		await run(payload({ tool_confirmation_pending: true }));
		process.env.TMUX_PANE = "%2";
		await run(payload({ tool_confirmation_pending: true }));
		expect(events()).toEqual([["PermissionRequest", "%1"], ["PermissionRequest", "%2"]]);
		expect(readdirSync(agyStatuslineTaskDir(home, "task-1")!)).toHaveLength(2);
	});

	it("one pane's wait ending leaves the other pane's recorded wait alone", async () => {
		process.env.TMUX_PANE = "%1";
		await run(payload({ tool_confirmation_pending: true }));
		process.env.TMUX_PANE = "%2";
		await run(payload({ tool_confirmation_pending: true }));
		mockSend.mockClear();

		process.env.TMUX_PANE = "%1";
		await run(payload({ tool_confirmation_pending: false, agent_state: "tool_use" }));
		expect(events()).toEqual([["PostToolUse", "%1"]]);

		// pane 2 is still pending: its next identical refresh says nothing new, its end is reported once.
		mockSend.mockClear();
		process.env.TMUX_PANE = "%2";
		await run(payload({ tool_confirmation_pending: true }));
		expect(mockSend).not.toHaveBeenCalled();
		await run(payload({ tool_confirmation_pending: false, agent_state: "tool_use" }));
		expect(events()).toEqual([["PostToolUse", "%2"]]);
	});

	it("falls back to the native pane id, then to the conversation id, for the pane key and the report", async () => {
		delete process.env.TMUX_PANE;
		process.env.DEV3_PANE_ID = "native-9";
		await run(payload({ tool_confirmation_pending: true, conversation_id: "conv-9" }));
		expect(mockSend.mock.calls[0]![2]).toMatchObject({ paneId: "native-9", sessionId: "conv-9" });
		expect(mockSend.mock.calls[1]![2]).toMatchObject({ paneId: "native-9", captureOnly: true, sessionId: "conv-9" });

		delete process.env.DEV3_PANE_ID;
		await run(payload({ tool_confirmation_pending: true, conversation_id: "conv-8" }));
		expect(readdirSync(agyStatuslineTaskDir(home, "task-1")!).sort()).toEqual(["pconv-8.json", "pnative-9.json"]);
	});

	it("does not move a card back when the turn already ended: a cleared wait while agy is idle sends nothing", async () => {
		await run(payload({ tool_confirmation_pending: true }));
		mockSend.mockClear();
		await run(payload({ tool_confirmation_pending: false, agent_state: "idle" }));
		expect(mockSend).not.toHaveBeenCalled();
		// and the wait is remembered as over, so it is not reported again
		await run(payload({ tool_confirmation_pending: false, agent_state: "tool_use" }));
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("starts clean after `hook agy SessionStart`: a wait left by a killed agy does not resume an idle task", async () => {
		await run(payload({ tool_confirmation_pending: true }));
		mockSend.mockClear();

		await handleAgyHook("SessionStart", JSON.stringify({ hookEventName: "SessionStart", conversationId: "conv-1" }), SOCKET, CONTEXT, home);
		mockSend.mockClear();
		await run(payload({ tool_confirmation_pending: false, agent_state: "tool_use" }));

		expect(mockSend).not.toHaveBeenCalled();
	});

	it("repeats a wait that goes on as a heartbeat, at most every 30 s", async () => {
		const pending = payload({ tool_confirmation_pending: true, conversation_id: "conv-1" });
		const sent = () => mockSend.mock.calls.filter((call) => !(call[2] as Record<string, unknown>).captureOnly).map((call) => [(call[2] as Record<string, unknown>).event, (call[2] as Record<string, unknown>).heartbeat]);
		await run(pending, { noLimits: true }, CONTEXT, NOW);
		await run(pending, { noLimits: true }, CONTEXT, NOW + 10_000);
		await run(pending, { noLimits: true }, CONTEXT, NOW + 29_000);
		expect(sent()).toEqual([["PermissionRequest", undefined]]);

		await run(pending, { noLimits: true }, CONTEXT, NOW + 31_000);
		await run(pending, { noLimits: true }, CONTEXT, NOW + 45_000);
		expect(sent()).toEqual([["PermissionRequest", undefined], ["PermissionRequest", true]]);
		await run(pending, { noLimits: true }, CONTEXT, NOW + 62_000);
		expect(sent()).toHaveLength(3);
		expect(mockSend.mock.calls[mockSend.mock.calls.length - 1]![2]).toMatchObject({ sessionId: "conv-1", heartbeat: true });
	});

	it("sends no heartbeat once the wait is over", async () => {
		await run(payload({ tool_confirmation_pending: true }), { noLimits: true }, CONTEXT, NOW);
		await run(payload({ tool_confirmation_pending: false, agent_state: "tool_use" }), { noLimits: true }, CONTEXT, NOW + 1_000);
		mockSend.mockClear();
		await run(payload({ tool_confirmation_pending: false }), { noLimits: true }, CONTEXT, NOW + 120_000);
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("rejects a conversation id that is not a plain token", async () => {
		await run(payload({ conversation_id: "a b; rm -rf /" }));
		expect(mockSend).not.toHaveBeenCalled();
	});
});

describe("agy statusline: where it writes", () => {
	it("uses the account's own dev3 home, not a launcher's HOME, unless DEV3_HOME redirects it", () => {
		expect(agyDev3Home({ HOME: "/launcher/private" })).toBe(`${resolveAccountHome()}/.dev3.0`);
		expect(agyDev3Home({ HOME: "/launcher/private", DEV3_HOME: "/redirected/home/" })).toBe("/redirected/home");
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
