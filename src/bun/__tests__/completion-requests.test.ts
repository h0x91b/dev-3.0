import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../logger", () => ({
	createLogger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

import {
	createCompletionRequest,
	resolveCompletionRequest,
	_resetCompletionRequestsForTests,
} from "../completion-requests";

beforeEach(() => {
	_resetCompletionRequestsForTests();
});

describe("createCompletionRequest", () => {
	it("creates a new pending request with a unique id", () => {
		const a = createCompletionRequest("task-1", "proj-1");
		const b = createCompletionRequest("task-2", "proj-1");

		expect(a.isNew).toBe(true);
		expect(b.isNew).toBe(true);
		expect(a.requestId).not.toBe(b.requestId);
	});

	it("joins the existing request for the same task instead of duplicating", () => {
		const first = createCompletionRequest("task-1", "proj-1");
		const second = createCompletionRequest("task-1", "proj-1");

		expect(second.isNew).toBe(false);
		expect(second.requestId).toBe(first.requestId);
		expect(second.decision).toBe(first.decision);
	});

	it("creates a fresh request after the previous one was resolved", () => {
		const first = createCompletionRequest("task-1", "proj-1");
		resolveCompletionRequest(first.requestId, false);

		const second = createCompletionRequest("task-1", "proj-1");
		expect(second.isNew).toBe(true);
		expect(second.requestId).not.toBe(first.requestId);
	});
});

describe("resolveCompletionRequest", () => {
	it("resolves the decision promise with true on approval", async () => {
		const { requestId, decision } = createCompletionRequest("task-1", "proj-1");

		expect(resolveCompletionRequest(requestId, true)).toBe(true);
		await expect(decision).resolves.toBe(true);
	});

	it("resolves the decision promise with false on decline", async () => {
		const { requestId, decision } = createCompletionRequest("task-1", "proj-1");

		expect(resolveCompletionRequest(requestId, false)).toBe(true);
		await expect(decision).resolves.toBe(false);
	});

	it("returns false for an unknown requestId", () => {
		expect(resolveCompletionRequest("nope", true)).toBe(false);
	});

	it("returns false when resolving the same request twice", () => {
		const { requestId } = createCompletionRequest("task-1", "proj-1");
		expect(resolveCompletionRequest(requestId, true)).toBe(true);
		expect(resolveCompletionRequest(requestId, true)).toBe(false);
	});

	it("resolves every joined waiter with the same decision", async () => {
		const first = createCompletionRequest("task-1", "proj-1");
		const second = createCompletionRequest("task-1", "proj-1");

		resolveCompletionRequest(first.requestId, true);
		await expect(first.decision).resolves.toBe(true);
		await expect(second.decision).resolves.toBe(true);
	});
});
