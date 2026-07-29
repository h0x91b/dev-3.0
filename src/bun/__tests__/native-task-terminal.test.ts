/**
 * The app's live per-pane binding to a native task terminal (seq 1311).
 *
 * bindNativeTaskPane must enforce the writer lease: the app holds exactly one
 * writer per pane; an observer's input and resize are dropped by the host with
 * no throw. It returns null when the session is already gone.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
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

vi.mock("../native-terminal-registry/client", () => ({
	NativeSessionClient: { discover: vi.fn(async () => client) },
}));

vi.mock("../native-terminal-registry/record", () => ({
	readRecord: vi.fn(() => ({ host: { pid: 10 }, shell: { pid: 11 }, paneId: "pane-1" })),
}));

import { NativeSessionClient } from "../native-terminal-registry/client";
import { bindNativeTaskPane } from "../native-task-terminal";

const SESSION_ID = "dev3-task-aabbccdd-1111-2222-3333-444444444444-pane-1";
const hooks = { onOutput: vi.fn(), onClosed: vi.fn() };

beforeEach(() => {
	vi.clearAllMocks();
	client.getRole.mockReturnValue("writer");
	client.claimWriter.mockResolvedValue({ role: "writer" });
	vi.mocked(NativeSessionClient.discover).mockResolvedValue(client as never);
});

describe("bindNativeTaskPane", () => {
	it("returns null when the session does not exist", async () => {
		vi.mocked(NativeSessionClient.discover).mockRejectedValue(new Error("not found"));
		const result = await bindNativeTaskPane(SESSION_ID, hooks);
		expect(result).toBeNull();
	});

	it("returns a terminal binding when the session exists", async () => {
		const terminal = await bindNativeTaskPane(SESSION_ID, hooks);
		expect(terminal).not.toBeNull();
		expect(terminal!.sessionId).toBe(SESSION_ID);
	});

	it("does not claim the lease when the host already made us the writer", async () => {
		await bindNativeTaskPane(SESSION_ID, hooks);
		expect(client.claimWriter).not.toHaveBeenCalled();
	});

	it("claims the lease when the role is not writer", async () => {
		client.getRole.mockReturnValue("observer");
		await bindNativeTaskPane(SESSION_ID, hooks);
		expect(client.claimWriter).toHaveBeenCalledTimes(1);
	});

	it("logs an error when the claim is refused", async () => {
		client.getRole.mockReturnValue("observer");
		client.claimWriter.mockResolvedValue({ role: "observer" });
		await bindNativeTaskPane(SESSION_ID, hooks);
		expect(log.error).toHaveBeenCalledTimes(1);
		expect(log.error.mock.calls[0][0]).toMatch(/OBSERVER/);
	});

	it("logs an error when the claim itself fails", async () => {
		client.getRole.mockReturnValue("observer");
		client.claimWriter.mockRejectedValue(new Error("host went away"));
		await bindNativeTaskPane(SESSION_ID, hooks);
		expect(log.error).toHaveBeenCalledTimes(1);
	});

	it("wires onOutput and onDisconnect hooks", async () => {
		await bindNativeTaskPane(SESSION_ID, hooks);
		expect(client.onOutput).toHaveBeenCalledWith(hooks.onOutput);
		expect(client.onDisconnect).toHaveBeenCalled();
	});

	it("write/resize delegate to the client", async () => {
		const terminal = await bindNativeTaskPane(SESSION_ID, hooks, "pane-1");
		terminal!.write("hi\r");
		expect(client.input).toHaveBeenCalledWith("hi\r");
		terminal!.resize(120, 40);
		expect(client.resize).toHaveBeenCalledWith(120, 40);
	});

	it("detach closes the client without calling onClosed", async () => {
		const terminal = await bindNativeTaskPane(SESSION_ID, hooks);
		terminal!.detach();
		expect(client.close).toHaveBeenCalled();
		expect(hooks.onClosed).not.toHaveBeenCalled();
	});
});
