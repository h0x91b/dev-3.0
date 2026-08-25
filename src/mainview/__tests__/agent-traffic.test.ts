import type { AgentMessageLogRow } from "../../shared/agent-message-log";
import { derivePairs, isUnsettled, livePairs, LIVE_WINDOW_MS } from "../agent-traffic";

const NOW = Date.parse("2026-08-25T12:00:00.000Z");

function row(over: Partial<AgentMessageLogRow> = {}): AgentMessageLogRow {
	return {
		v: 1,
		at: new Date(NOW).toISOString(),
		fromTaskId: "task-a",
		fromSeq: 11,
		fromTitle: "Coordinator",
		toTaskId: "task-b",
		toSeq: 22,
		toTitle: "Worker",
		toProjectId: "proj-1",
		kind: "immediate",
		body: "hello",
		bodyKind: "text",
		status: "delivered",
		...over,
	};
}

describe("derivePairs", () => {
	// A pair is a channel, not a direction: the same two tasks answering each other
	// must stay ONE row, otherwise the header counts every conversation twice.
	it("folds both directions into a single pair", () => {
		const pairs = derivePairs([
			row({ at: new Date(NOW).toISOString() }),
			row({
				at: new Date(NOW - 60_000).toISOString(),
				fromTaskId: "task-b",
				fromSeq: 22,
				toTaskId: "task-a",
				toSeq: 11,
			}),
		]);
		expect(pairs).toHaveLength(1);
		expect(pairs[0].count).toBe(2);
	});

	// "Who owes an answer" is derived, never stored: whoever RECEIVED the newest
	// message is the one that has not replied.
	it("points at the receiver of the newest message", () => {
		const pairs = derivePairs([
			row({ at: new Date(NOW - 60_000).toISOString() }),
			row({
				at: new Date(NOW).toISOString(),
				fromTaskId: "task-b",
				fromSeq: 22,
				toTaskId: "task-a",
				toSeq: 11,
			}),
		]);
		expect(pairs[0].fromSeq).toBe(22);
		expect(pairs[0].toSeq).toBe(11);
		expect(pairs[0].toTaskId).toBe("task-a");
	});

	// The rows arrive newest-first from disk, but a torn/unordered file must not be
	// able to make an older message look like the latest word.
	it("ignores row order when picking the newest", () => {
		const pairs = derivePairs([
			row({ at: new Date(NOW - 600_000).toISOString(), body: "older" }),
			row({ at: new Date(NOW).toISOString(), body: "newest" }),
		]);
		expect(pairs[0].last.body).toBe("newest");
	});

	// A dev3 hand-off has no sending agent, so it is not agent-to-agent traffic and
	// must not invent a pair with a phantom peer.
	it("skips rows with no sender", () => {
		expect(derivePairs([row({ fromTaskId: null, fromSeq: null })])).toHaveLength(0);
	});

	// One unproven message taints the pair: that is the thing the human has to look at.
	it("marks a pair unsettled when any of its rows is unproven", () => {
		const pairs = derivePairs([
			row({ at: new Date(NOW).toISOString(), status: "delivered" }),
			row({ at: new Date(NOW - 1000).toISOString(), status: "unconfirmed" }),
		]);
		expect(pairs[0].unsettled).toBe(true);
	});

	it("sorts the newest pair first", () => {
		const pairs = derivePairs([
			row({ at: new Date(NOW - 500_000).toISOString(), toTaskId: "task-c", toSeq: 33 }),
			row({ at: new Date(NOW).toISOString() }),
		]);
		expect(pairs.map((pair) => pair.toSeq)).toEqual([22, 33]);
	});
});

describe("livePairs", () => {
	// Silence is the header's normal state: a pair that stopped talking before the
	// window drops out, which is what lets the glyph disappear entirely.
	it("keeps only pairs inside the live window", () => {
		const pairs = derivePairs([
			row({ at: new Date(NOW - 1000).toISOString() }),
			row({ at: new Date(NOW - LIVE_WINDOW_MS - 1000).toISOString(), toTaskId: "task-c", toSeq: 33 }),
		]);
		expect(pairs).toHaveLength(2);
		const live = livePairs(pairs, NOW);
		expect(live).toHaveLength(1);
		expect(live[0].toSeq).toBe(22);
	});
});

describe("isUnsettled", () => {
	// `held` is a promise, not a failure — dev3 accepted it and will type it when the
	// pane goes quiet, so it must never be shown as a problem.
	it("treats held and delivered as settled", () => {
		expect(isUnsettled("delivered")).toBe(false);
		expect(isUnsettled("held")).toBe(false);
		expect(isUnsettled("unconfirmed")).toBe(true);
		expect(isUnsettled("not-delivered")).toBe(true);
	});
});
