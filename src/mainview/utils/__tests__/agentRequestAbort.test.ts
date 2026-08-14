import { describe, it, expect } from "vitest";
import { createAgentRequestAbort } from "../agentRequestAbort";

function fireResolved(detail: Record<string, unknown>) {
	window.dispatchEvent(new CustomEvent("rpc:agentRequestResolved", { detail }));
}

describe("createAgentRequestAbort", () => {
	it("aborts when the same request is answered on another client", () => {
		const { signal, cleanup } = createAgentRequestAbort("req-1");

		fireResolved({ requestId: "req-1", kind: "complete", taskId: "t1", projectId: "p1" });

		expect(signal.aborted).toBe(true);
		cleanup();
	});

	it("ignores another request's resolution", () => {
		const { signal, cleanup } = createAgentRequestAbort("req-1");

		fireResolved({ requestId: "req-2", kind: "launch", taskId: "t2", projectId: "p1" });

		expect(signal.aborted).toBe(false);
		cleanup();
	});

	it("stops listening after cleanup", () => {
		const { signal, cleanup } = createAgentRequestAbort("req-1");
		cleanup();

		fireResolved({ requestId: "req-1", kind: "complete", taskId: "t1", projectId: "p1" });

		expect(signal.aborted).toBe(false);
	});
});
