import { describe, expect, it } from "vitest";
import type { ModelRate } from "../../shared/agent-pricing";
import {
	isFullRewrite,
	parseTranscript,
	simulateCompaction,
	summarize,
	taskIdOfProjectDir,
	type RequestUsage,
} from "../../../scripts/agent-token-cost";

const RATE: ModelRate = { input: 1, output: 10, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 };
const rateOf = () => RATE;

function assistant(id: string, usage: Record<string, unknown>, content: unknown[] = [], ts = "2026-09-01T10:00:00Z") {
	return { type: "assistant", timestamp: ts, requestId: `req-${id}`, message: { id, model: "claude-test", usage, content } };
}

function usage(read: number, write1h: number, output = 10) {
	return {
		input_tokens: 1,
		cache_read_input_tokens: read,
		cache_creation_input_tokens: write1h,
		cache_creation: { ephemeral_1h_input_tokens: write1h, ephemeral_5m_input_tokens: 0 },
		output_tokens: output,
	};
}

function jsonl(entries: unknown[]): string {
	return entries.map((e) => JSON.stringify(e)).join("\n");
}

function req(over: Partial<RequestUsage>): RequestUsage {
	return { ts: 0, model: "claude-test", input: 0, write5m: 0, write1h: 0, read: 0, output: 0, trigger: "human", bookkeepingOnly: false, ...over };
}

describe("parseTranscript", () => {
	it("counts one request per API response even when it is logged once per content block", () => {
		const u = usage(1000, 500);
		const trace = parseTranscript(
			jsonl([
				{ type: "user", message: { content: "fix it" } },
				assistant("m1", u, [{ type: "thinking" }]),
				assistant("m1", u, [{ type: "tool_use", name: "Read", input: {} }]),
			]),
			false,
		);
		expect(trace.requests).toHaveLength(1);
		expect(trace.requests[0]).toMatchObject({ read: 1000, write1h: 500, output: 10, trigger: "human" });
	});

	it("names what woke the model: a human, a dev3 message, or a tool result", () => {
		const trace = parseTranscript(
			jsonl([
				{ type: "user", message: { content: "hi" } },
				assistant("a", usage(0, 100)),
				{ type: "attachment", attachment: { type: "queued_command" }, rendered: [{ content: "<dev3-ai-message>\n<from-task>seq:1</from-task>" }] },
				assistant("b", usage(100, 10)),
				{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } },
				assistant("c", usage(110, 10)),
			]),
			false,
		);
		expect(trace.requests.map((r) => r.trigger)).toEqual(["human", "agent-message", "tool-result"]);
	});

	it("marks a request whose every tool call is dev3 bookkeeping", () => {
		const bash = (command: string) => ({ type: "tool_use", name: "Bash", input: { command } });
		const trace = parseTranscript(
			jsonl([
				assistant("a", usage(0, 100), [bash('dev3 overview set "done"'), bash("dev3 note add x")]),
				assistant("b", usage(100, 10), [bash('dev3 overview set "x"'), bash("bun run lint")]),
			]),
			false,
		);
		expect(trace.requests.map((r) => r.bookkeepingOnly)).toEqual([true, false]);
	});

	it("splits the first-turn context into the sources dev3 does and does not own", () => {
		const trace = parseTranscript(
			jsonl([
				{ type: "attachment", attachment: { type: "prompt_snapshot", systemPrompt: ["base prompt", "# dev3 — Task Lifecycle Protocol\nbody"] } },
				{
					type: "attachment",
					attachment: { type: "skill_listing" },
					rendered: [{ content: "- dev3-tmux: tmux help\n- render-cli: render things\n- ask-dev3: router" }],
				},
				{ type: "user", message: { content: "<teammate-message teammate_id=\"lead\">go" } },
				assistant("a", usage(0, 100)),
				{ type: "attachment", attachment: { type: "output_style_instructions" }, rendered: [{ content: "late, ignored" }] },
			]),
			false,
		);
		expect(trace.kind).toBe("teammate");
		expect(trace.staticChars["dev3 protocol (system prompt)"]).toBe("# dev3 — Task Lifecycle Protocol\nbody".length);
		expect(trace.staticChars["Claude Code system prompt"]).toBe("base prompt".length);
		expect(trace.staticChars["skill listing: dev3-shipped skills"]).toBe("- dev3-tmux: tmux help\n".length + "- ask-dev3: router\n".length);
		expect(trace.staticChars["output style"]).toBeUndefined();
	});
});

describe("isFullRewrite", () => {
	it("is a re-write when the request wrote the conversation instead of reading it", () => {
		const prev = req({ read: 200_000, write1h: 1000 });
		expect(isFullRewrite(req({ read: 30_000, write1h: 180_000 }), prev)).toBe(true);
		expect(isFullRewrite(req({ read: 201_000, write1h: 2000 }), prev)).toBe(false);
		// A context that shrank after a compaction reads little and writes little.
		expect(isFullRewrite(req({ read: 30_000, write1h: 5000 }), prev)).toBe(false);
		expect(isFullRewrite(req({ read: 0, write1h: 50_000 }), undefined)).toBe(false);
	});
});

describe("summarize", () => {
	it("prices each billing type separately and files a re-write under its cause", () => {
		const h = 3600_000;
		const report = summarize(
			[
				{
					task: "aaaaaaaa",
					sessions: [
						{
							kind: "lead",
							staticChars: {},
							requests: [
								req({ ts: 0, read: 1_000_000, write1h: 1_000_000, output: 100_000 }),
								req({ ts: 2 * h, write1h: 2_000_000, trigger: "agent-message" }),
							],
						},
					],
				},
			],
			rateOf,
		);
		expect(report.usd).toEqual({ input: 0, write5m: 0, write1h: 6, read: 0.1, output: 1 });
		expect(report.total).toBeCloseTo(7.1);
		expect(report.rewrites).toEqual({ "idle > 60 min, woken by agent-message": { count: 1, usd: 4 } });
	});
});

describe("simulateCompaction", () => {
	const sessions = [
		{
			task: "aaaaaaaa",
			sessions: [
				{
					kind: "lead" as const,
					staticChars: {},
					requests: Array.from({ length: 20 }, (_, i) => req({ ts: i * 1000, read: 50_000 + i * 50_000, write1h: 50_000, output: 1000 })),
				},
			],
		},
	];

	it("changes nothing when no session reaches the threshold", () => {
		const sim = simulateCompaction(sessions, 10_000_000, 3000, rateOf);
		expect(sim.compactions).toBe(0);
		expect(sim.simulated).toBeCloseTo(sim.actual);
	});

	it("costs less than the real run when long contexts are cut short", () => {
		const sim = simulateCompaction(sessions, 400_000, 3000, rateOf);
		expect(sim.compactions).toBeGreaterThan(0);
		expect(sim.simulated).toBeLessThan(sim.actual);
	});
});

describe("taskIdOfProjectDir", () => {
	it("reads the task id from a dev3 worktree transcript dir and ignores the rest", () => {
		expect(taskIdOfProjectDir("-Users-me--dev3-0-worktrees-Users-me-src-app-86e6945b-worktree")).toBe("86e6945b");
		expect(taskIdOfProjectDir("-Users-me-src-app")).toBeNull();
	});
});
