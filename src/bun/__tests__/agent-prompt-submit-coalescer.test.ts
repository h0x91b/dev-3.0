import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
	AGENT_MESSAGE_SUBMIT_CEILING_MS,
	AGENT_MESSAGE_SUBMIT_IDLE_MS,
} from "../../shared/agent-message-coalescing";
import {
	agentPromptSubmitKey,
	coalesceAgentPromptSubmit,
	pendingAgentPromptSubmitCount,
	resetAgentPromptSubmits,
} from "../agent-prompt-submit-coalescer";

const KEY = agentPromptSubmitKey("tmux", "task-1", "%1");
const OTHER = agentPromptSubmitKey("tmux", "task-1", "%2");

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
	resetAgentPromptSubmits();
	vi.useRealTimers();
});

describe("coalesceAgentPromptSubmit — the idle window", () => {
	it("fires once the pane has been quiet for the whole window", async () => {
		const submit = vi.fn();
		expect(coalesceAgentPromptSubmit(KEY, submit, {})).toBe(AGENT_MESSAGE_SUBMIT_IDLE_MS);

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_SUBMIT_IDLE_MS - 1);
		expect(submit).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(submit).toHaveBeenCalledTimes(1);
		expect(pendingAgentPromptSubmitCount()).toBe(0);
	});

	it("collapses a burst into ONE submit, pushed back by every message", async () => {
		// Three messages 4s apart: the Enter must not land between them, and it must
		// be a single Enter — one per message would split the burst into three turns.
		const first = vi.fn();
		const second = vi.fn();
		const third = vi.fn();
		coalesceAgentPromptSubmit(KEY, first, {});
		await vi.advanceTimersByTimeAsync(4_000);
		coalesceAgentPromptSubmit(KEY, second, {});
		await vi.advanceTimersByTimeAsync(4_000);
		coalesceAgentPromptSubmit(KEY, third, {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_SUBMIT_IDLE_MS - 1);
		expect(third).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		// The newest registration owns the submit: it carries the freshest pane pin.
		expect(third).toHaveBeenCalledTimes(1);
		expect(first).not.toHaveBeenCalled();
		expect(second).not.toHaveBeenCalled();
	});

	it("keeps each pane's window separate", async () => {
		const one = vi.fn();
		const two = vi.fn();
		coalesceAgentPromptSubmit(KEY, one, {});
		coalesceAgentPromptSubmit(OTHER, two, {});
		expect(pendingAgentPromptSubmitCount()).toBe(2);

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_SUBMIT_IDLE_MS);
		expect(one).toHaveBeenCalledTimes(1);
		expect(two).toHaveBeenCalledTimes(1);
	});

	it("starts a fresh window after a submit has fired", async () => {
		const first = vi.fn();
		const later = vi.fn();
		coalesceAgentPromptSubmit(KEY, first, {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_SUBMIT_IDLE_MS);
		expect(coalesceAgentPromptSubmit(KEY, later, {})).toBe(AGENT_MESSAGE_SUBMIT_IDLE_MS);

		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_SUBMIT_IDLE_MS);
		expect(later).toHaveBeenCalledTimes(1);
	});
});

describe("coalesceAgentPromptSubmit — the ceiling", () => {
	it("submits at the ceiling even while messages keep arriving", async () => {
		// A steady stream every 5s never lets the idle window close. Without the
		// ceiling the receiving agent would never read a word.
		const submits: ReturnType<typeof vi.fn>[] = [];
		let elapsed = 0;
		while (elapsed < AGENT_MESSAGE_SUBMIT_CEILING_MS) {
			const submit = vi.fn();
			submits.push(submit);
			coalesceAgentPromptSubmit(KEY, submit, {});
			await vi.advanceTimersByTimeAsync(5_000);
			elapsed += 5_000;
		}
		expect(submits.filter((s) => s.mock.calls.length > 0)).toHaveLength(1);
	});

	it("reports a shrinking delay as the ceiling approaches", async () => {
		// Kept alive by a message every 5s, so the window never closes on its own.
		coalesceAgentPromptSubmit(KEY, vi.fn(), {});
		let elapsed = 0;
		while (elapsed < AGENT_MESSAGE_SUBMIT_CEILING_MS - 5_000) {
			await vi.advanceTimersByTimeAsync(5_000);
			elapsed += 5_000;
			coalesceAgentPromptSubmit(KEY, vi.fn(), {});
		}
		await vi.advanceTimersByTimeAsync(1_000);
		// 4s of headroom left, so the promised delay is 4s and not the full window.
		expect(coalesceAgentPromptSubmit(KEY, vi.fn(), {})).toBe(4_000);
	});
});

describe("coalesceAgentPromptSubmit — failures", () => {
	it("survives a submit that throws and clears the pane", async () => {
		coalesceAgentPromptSubmit(KEY, () => {
			throw new Error("pane died");
		}, {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_SUBMIT_IDLE_MS);
		expect(pendingAgentPromptSubmitCount()).toBe(0);
	});

	it("survives a submit that rejects", async () => {
		coalesceAgentPromptSubmit(KEY, () => Promise.reject(new Error("pane died")), {});
		await vi.advanceTimersByTimeAsync(AGENT_MESSAGE_SUBMIT_IDLE_MS);
		expect(pendingAgentPromptSubmitCount()).toBe(0);
	});
});
