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
	takeoverWriter: vi.fn(async () => ({ role: "writer" as string })),
	resizeAwaited: vi.fn(async (cols: number, rows: number) => ({ cols, rows })),
	releaseWriter: vi.fn(async () => ({ role: "observer" as string })),
	// Capability negotiation replaces timeout inference: a host that does not ANNOUNCE
	// `takeover` is the only thing that may ever yield `host-too-old`.
	supports: vi.fn((capability: string) => capability === "takeover"),
	onOutput: vi.fn(),
	onError: vi.fn(),
	onDisconnect: vi.fn(),
	input: vi.fn(),
	resize: vi.fn(),
	close: vi.fn(),
}));

vi.mock("../logger", () => ({ createLogger: () => log }));

const OwnershipTimeoutError = vi.hoisted(
	() =>
		class OwnershipTimeoutError extends Error {
			constructor(readonly action: string) {
				super(`ownership ${action} timeout`);
				this.name = "OwnershipTimeoutError";
			}
		},
);

// Shaped like the real class: the verdict is decided by `instanceof` plus `code`, so a
// looser stub would let a message-matching regression pass.
const HostRefusedError = vi.hoisted(
	() =>
		class HostRefusedError extends Error {
			constructor(readonly code: string, message?: string) {
				super(`native session error: ${code}${message ? ` (${message})` : ""}`);
				this.name = "HostRefusedError";
			}
		},
);

vi.mock("../native-terminal-registry/client", () => ({
	NativeSessionClient: { discover: vi.fn(async () => client) },
	OwnershipTimeoutError,
	HostRefusedError,
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
	client.takeoverWriter.mockResolvedValue({ role: "writer" });
	client.releaseWriter.mockResolvedValue({ role: "observer" });
	client.supports.mockImplementation((capability: string) => capability === "takeover");
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

/**
 * The explicit `Take control` gesture. The invariant that must survive
 * every change here: ATTACHING never steals, and only a takeover-frame timeout —
 * the one honest signal of a host too old to transfer — may fall back to a claim.
 */
describe("takeoverHostWriter", () => {
	it("is never used by implicit attachment — that path only ever claims", async () => {
		client.getRole.mockReturnValue("observer");
		await bindNativeTaskPane(SESSION_ID, hooks);
		expect(client.claimWriter).toHaveBeenCalledTimes(1);
		expect(client.takeoverWriter).not.toHaveBeenCalled();
	});

	it("sends ONE takeover frame and reports the writer role", async () => {
		client.getRole.mockReturnValue("observer");
		const terminal = await bindNativeTaskPane(SESSION_ID, hooks);
		client.claimWriter.mockClear();

		await expect(terminal!.takeoverHostWriter()).resolves.toEqual({ ok: true });
		expect(client.takeoverWriter).toHaveBeenCalledTimes(1);
		expect(client.claimWriter).not.toHaveBeenCalled();
	});

	// P1-1: our cached role can be STALE — another process may already hold the lease and
	// our demotion frame may be in flight — so an explicit gesture must always reach the
	// host. Skipping it would make a deliberate click silently do nothing. The host's
	// takeover is idempotent for the true current writer, so asking is free.
	it("still asks the host even when our cached role says we are the writer", async () => {
		client.getRole.mockReturnValue("writer");
		const terminal = await bindNativeTaskPane(SESSION_ID, hooks);

		await expect(terminal!.takeoverHostWriter()).resolves.toEqual({ ok: true });
		expect(client.takeoverWriter).toHaveBeenCalledTimes(1);
	});

	// Capability negotiation, not timeout inference: only a host that does not ANNOUNCE
	// `takeover` may ever produce `host-too-old`.
	it("falls back to a claim on a host that does not announce takeover, winning a vacant slot", async () => {
		client.getRole.mockReturnValue("observer");
		client.supports.mockReturnValue(false);
		const terminal = await bindNativeTaskPane(SESSION_ID, hooks);
		client.claimWriter.mockResolvedValue({ role: "writer" });

		await expect(terminal!.takeoverHostWriter()).resolves.toEqual({ ok: true });
		expect(client.takeoverWriter).not.toHaveBeenCalled();
	});

	it("reports host-too-old only when an unannounced host still has a live writer", async () => {
		client.getRole.mockReturnValue("observer");
		client.supports.mockReturnValue(false);
		const terminal = await bindNativeTaskPane(SESSION_ID, hooks);
		client.claimWriter.mockResolvedValue({ role: "observer" });

		await expect(terminal!.takeoverHostWriter()).resolves.toEqual({ ok: false, refusal: "host-too-old" });
	});

	it("keeps a takeover TIMEOUT as transfer-failed on a capable host — no old-host inference", async () => {
		client.getRole.mockReturnValue("observer");
		const terminal = await bindNativeTaskPane(SESSION_ID, hooks);
		client.claimWriter.mockClear();
		client.takeoverWriter.mockRejectedValue(new OwnershipTimeoutError("takeover"));

		// A timeout also carries `timedOut`, because the host may still commit it and the
		// caller has to COMPENSATE rather than just report a failure.
		await expect(terminal!.takeoverHostWriter()).resolves.toEqual({
			ok: false,
			refusal: "transfer-failed",
			timedOut: true,
		});
		expect(client.claimWriter).not.toHaveBeenCalled();
	});

	// Only the host's own authoritative conflict may mean host-too-old. Anything
	// we could not interpret says NOTHING about who owns the lease.
	it.each([
		["a disconnect", new Error("connection closed before ownership reply"), "transfer-failed"],
		["an auth failure", new HostRefusedError("unauthorized"), "transfer-failed"],
		["a timeout", new OwnershipTimeoutError("claim"), "transfer-failed"],
		["an unparseable reply", new Error("native session sent an unparseable reply"), "transfer-failed"],
		["a non-conflict host refusal", new HostRefusedError("internal-error"), "transfer-failed"],
		["an authoritative writer-active conflict", new HostRefusedError("conflict", "another client is already the writer"), "host-too-old"],
	])("maps %s to the right verdict on a host that cannot transfer", async (_label, failure, expected) => {
		client.getRole.mockReturnValue("observer");
		client.supports.mockReturnValue(false);
		const terminal = await bindNativeTaskPane(SESSION_ID, hooks);
		client.claimWriter.mockRejectedValue(failure);

		const result = await terminal!.takeoverHostWriter();

		expect(result.ok).toBe(false);
		expect(result.ok === false && result.refusal).toBe(expected);
	});

	it("reports an unconfirmed release so the caller can drop the connection", async () => {
		const terminal = await bindNativeTaskPane(SESSION_ID, hooks);
		client.releaseWriter.mockRejectedValue(new Error("host went away"));

		await expect(terminal!.releaseHostWriter()).resolves.toBe(false);
	});

	// The mutation this guards against: widening the fallback to "any failure", or to
	// "any timeout". Either would tell the user to restart a terminal that is fine,
	// and would fire a claim the caller never asked for. `transfer-failed` stays
	// generic on purpose — the real cause is logged, never guessed at in the UI.
	it.each([
		["a disconnect", new Error("connection closed before ownership reply")],
		["an auth failure", new Error("native session error: unauthorized")],
		["a host conflict frame", new Error("native session error: conflict (client has not completed attach)")],
		["a stale-generation conflict", new Error("native session error: conflict (writer generation is stale)")],
		["an unrelated timeout", new OwnershipTimeoutError("release")],
		["a non-Error rejection", "socket exploded"],
	])("surfaces %s as itself instead of relabelling it host-too-old", async (_label, failure) => {
		client.getRole.mockReturnValue("observer");
		const terminal = await bindNativeTaskPane(SESSION_ID, hooks);
		client.claimWriter.mockClear();
		client.takeoverWriter.mockRejectedValue(failure);

		const result = await terminal!.takeoverHostWriter();

		// `timedOut` rides along only for the timeout case, since that alone needs
		// compensation; every other class is a plain transfer-failed.
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.refusal).toBe("transfer-failed");
		expect(client.claimWriter).not.toHaveBeenCalled();
	});
});
