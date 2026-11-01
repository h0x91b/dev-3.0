import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretRequests } from "../secret-requests";
import { SECRET_RUN_MS, SECRET_WAIT_MS, type SecretRequest } from "../../shared/secret-request";

const input = { projectId: "p", taskId: "t", taskTitle: "Upload", env: "TOKEN", command: ["upload"], cwd: "/worktree", runStartedAt: null };
afterEach(() => vi.useRealTimers());

function setup(run = vi.fn(async (_request: SecretRequest, _secret: string, _signal: AbortSignal) => 0)) {
	const push = vi.fn();
	const broker = new SecretRequests(run, push);
	const controller = new AbortController();
	const result = broker.request(input, controller.signal);
	const id = broker.list()[0]!.requestId;
	return { broker, push, run, controller, result, id };
}

describe("secret requests", () => {
	it("executes once and returns only status, with no secret in pushes or listings", async () => {
		const { broker, id, result, run, push } = setup();
		expect(broker.respond(id, "test-private-value")).toBe(true);
		expect(broker.respond(id, "second-value")).toBe(false);
		expect(broker.list()).toEqual([]);
		expect(await result).toEqual({ status: "finished", exitCode: 0 });
		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0]).toEqual([expect.objectContaining(input), "test-private-value", expect.any(AbortSignal)]);
		expect(JSON.stringify(push.mock.calls)).not.toContain("test-private-value");
	});
	it("declines without running", async () => {
		const { broker, id, result, run } = setup();
		broker.respond(id);
		expect(await result).toEqual({ status: "declined" });
		expect(run).not.toHaveBeenCalled();
	});
	it("removes a disconnected CLI request and refuses late approval", async () => {
		const { broker, id, controller, result, run } = setup();
		controller.abort();
		expect(await result).toEqual({ status: "cancelled" });
		expect(broker.respond(id, "too-late")).toBe(false);
		expect(run).not.toHaveBeenCalled();
	});
	it("aborts an executing command when the CLI disconnects", async () => {
		let runningSignal: AbortSignal | undefined;
		const run = vi.fn((_request, _secret, signal: AbortSignal) => {
			runningSignal = signal;
			return new Promise<number>(() => {});
		});
		const { broker, id, controller, result } = setup(run);
		broker.respond(id, "test-value");
		await Promise.resolve();
		controller.abort();
		expect(await result).toEqual({ status: "cancelled" });
		expect(runningSignal?.aborted).toBe(true);
	});

	it("expires without auto-approval", async () => {
		vi.useFakeTimers();
		const { broker, id, result, run } = setup();
		await vi.advanceTimersByTimeAsync(SECRET_WAIT_MS);
		expect(await result).toEqual({ status: "expired" });
		expect(broker.respond(id, "late")).toBe(false);
		expect(run).not.toHaveBeenCalled();
	});

	it("gives a late approval its full command time limit", async () => {
		vi.useFakeTimers();
		const { broker, id, result } = setup(vi.fn(() => new Promise<number>(() => {})));
		await vi.advanceTimersByTimeAsync(SECRET_WAIT_MS - 1);
		broker.respond(id, "test-value");
		await vi.advanceTimersByTimeAsync(SECRET_RUN_MS);
		expect(await result).toEqual({ status: "expired" });
	});

	it("returns a generic failure even when the runner throws the secret", async () => {
		const { broker, id, result } = setup(vi.fn(async () => { throw new Error("test-private-value"); }));
		broker.respond(id, "test-private-value");
		expect(await result).toEqual({ status: "failed" });
	});

	it("refuses concurrent requests for one task", async () => {
		const { broker, controller, result } = setup();
		expect(() => broker.request(input)).toThrow("already pending");
		controller.abort();
		await result;
	});

	it.each(["", "bad\0value", "x".repeat(16_385)])("rejects invalid input without consuming the request", async (value) => {
		const { broker, id, controller, result, run } = setup();
		expect(() => broker.respond(id, value)).toThrow("Enter a non-empty secret");
		expect(run).not.toHaveBeenCalled();
		controller.abort();
		await result;
	});

	it("does not let a listing mutate the approved command", async () => {
		const { broker, id, result, run } = setup();
		broker.list()[0]!.command[0] = "other";
		broker.respond(id, "test-value");
		await result;
		expect(run.mock.calls[0]?.[0].command).toEqual(["upload"]);
	});
});
