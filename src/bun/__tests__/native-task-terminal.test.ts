/**
 * The app's live binding to a native task terminal (seq 1292).
 *
 * Two properties that failed silently before they were fixed: a teardown is only
 * "done" once the session is really gone (the next launch reuses the deterministic
 * id), and the app must hold the host's WRITER lease — an observer's input and
 * resize are dropped by the host with no throw anywhere.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
const backend = vi.hoisted(() => ({
	openSession: vi.fn(async () => undefined),
	describeSession: vi.fn(async () => null as unknown),
	cleanupSession: vi.fn(async () => undefined),
}));
const client = vi.hoisted(() => ({
	getRole: vi.fn(() => "writer" as string | null),
	claimWriter: vi.fn(async () => ({ role: "writer" as string })),
	onOutput: vi.fn(),
	onError: vi.fn(),
	onDisconnect: vi.fn(),
	input: vi.fn(),
	resize: vi.fn(),
	close: vi.fn(),
}));

vi.mock("../logger", () => ({ createLogger: () => log }));

vi.mock("../task-terminal-backend", () => ({
	nativeTaskSessionId: (taskId: string) => `dev3-task-${taskId}`,
	nativeTaskTerminalBackend: () => backend,
}));

vi.mock("../native-host-runtime", () => ({
	resolveNativeHostRuntime: vi.fn(() => ({ kind: "development-entrypoint", origin: "test" })),
}));

vi.mock("../native-terminal-registry/client", () => ({
	NativeSessionClient: { discover: vi.fn(async () => client) },
}));

vi.mock("../native-terminal-registry/record", () => ({
	readRecord: vi.fn(() => ({ host: { pid: 10 }, shell: { pid: 11 } })),
}));

import {
	attachNativeTaskTerminal,
	stopNativeTaskTerminal,
} from "../native-task-terminal";

const TASK_ID = "aabbccdd-1111-2222-3333-444444444444";
const SESSION_ID = `dev3-task-${TASK_ID}`;

const hooks = { onOutput: vi.fn(), onClosed: vi.fn() };

beforeEach(() => {
	vi.clearAllMocks();
	backend.describeSession.mockResolvedValue(null);
	client.getRole.mockReturnValue("writer");
	client.claimWriter.mockResolvedValue({ role: "writer" });
});

describe("stopNativeTaskTerminal", () => {
	it("cleans the session up tolerating an already-gone one", async () => {
		await stopNativeTaskTerminal(TASK_ID);

		expect(backend.cleanupSession).toHaveBeenCalledWith(SESSION_ID, { ignoreMissing: true });
	});

	it("resolves once the session really is gone", async () => {
		backend.describeSession.mockResolvedValue(null);

		await expect(stopNativeTaskTerminal(TASK_ID)).resolves.toBeUndefined();
	});

	it("fails, naming the session, when the tree is still present afterwards", async () => {
		backend.describeSession.mockResolvedValue({ id: SESSION_ID, status: "running" });

		await expect(stopNativeTaskTerminal(TASK_ID)).rejects.toThrow(SESSION_ID);
		await expect(stopNativeTaskTerminal(TASK_ID)).rejects.toThrow(/still present after teardown/);
	});
});

describe("writer lease on attach", () => {
	beforeEach(() => {
		backend.describeSession.mockResolvedValue({ id: SESSION_ID, status: "running" });
	});

	it("claims the lease exactly once when the role is not writer", async () => {
		client.getRole.mockReturnValue("observer");

		await attachNativeTaskTerminal(TASK_ID, hooks);

		expect(client.claimWriter).toHaveBeenCalledTimes(1);
	});

	it("does not claim anything when the host already made us the writer", async () => {
		await attachNativeTaskTerminal(TASK_ID, hooks);

		expect(client.claimWriter).not.toHaveBeenCalled();
	});

	it("logs an error when the claim is refused", async () => {
		client.getRole.mockReturnValue("observer");
		client.claimWriter.mockResolvedValue({ role: "observer" });

		await attachNativeTaskTerminal(TASK_ID, hooks);

		expect(log.error).toHaveBeenCalledTimes(1);
		expect(log.error.mock.calls[0][0]).toMatch(/OBSERVER/);
	});

	it("logs an error when the claim itself fails", async () => {
		client.getRole.mockReturnValue("observer");
		client.claimWriter.mockRejectedValue(new Error("host went away"));

		await attachNativeTaskTerminal(TASK_ID, hooks);

		expect(log.error).toHaveBeenCalledTimes(1);
	});
});
