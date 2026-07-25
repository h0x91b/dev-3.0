/**
 * Native-adapter specifics the shared conformance suite cannot express:
 * ownership-safe reads, the deferred multi-view boundary as a typed
 * `unsupported`, and the wrapping of unexpected native failures.
 */

import { describe, expect, it } from "vitest";
import { NativeTerminalBackend } from "../native-backend";
import { isTerminalBackendError, TerminalBackendError } from "../errors";
import { FakeNativeWorld } from "./fake-native-world";

const SESSION = "task-native";

function harness() {
	const world = new FakeNativeWorld();
	return { world, backend: new NativeTerminalBackend({ deps: world.deps() }) };
}

async function code(run: () => Promise<unknown>): Promise<string> {
	try {
		await run();
		return "no-error";
	} catch (err) {
		if (!isTerminalBackendError(err)) throw err;
		return err.code;
	}
}

describe("NativeTerminalBackend", () => {
	it("reports the native backend kind", () => {
		expect(harness().backend.kind).toBe("native");
	});

	it("treats a record owned by another instance as absent", async () => {
		const { world, backend } = harness();
		await backend.openSession({ id: SESSION, cwd: "/tmp" });
		world.ownership = "foreign";
		await expect(backend.describeSession(SESSION)).resolves.toBeNull();
		expect(await code(() => backend.attachView(SESSION))).toBe("session-not-found");
	});

	it("refuses to focus a second view as unsupported, not as a failure", async () => {
		const { backend } = harness();
		await backend.openSession({ id: SESSION, cwd: "/tmp" });
		expect(await code(() => backend.focusView(SESSION, `${SESSION}:1`))).toBe("unsupported");
	});

	it("names the deferred layout work in the unsupported message", async () => {
		const { backend } = harness();
		const created = await backend.openSession({ id: SESSION, cwd: "/tmp" });
		await expect(backend.splitView(SESSION, created.views[0].id, { cwd: "/tmp" })).rejects.toThrow(
			/LAY-003/,
		);
	});

	it("wraps an unexpected native failure as backend-failure with its cause", async () => {
		const world = new FakeNativeWorld();
		const boom = new Error("host refused to start");
		const backend = new NativeTerminalBackend({
			deps: { ...world.deps(), start: (() => Promise.reject(boom)) as never },
		});
		const err = await backend.openSession({ id: SESSION, cwd: "/tmp" }).catch((e) => e);
		expect(err).toBeInstanceOf(TerminalBackendError);
		expect(err.code).toBe("backend-failure");
		expect(err.cause).toBe(boom);
	});

	it("releases its attached client on dispose without stopping the session", async () => {
		const world = new FakeNativeWorld();
		const backend = new NativeTerminalBackend({ deps: world.deps() });
		await backend.openSession({ id: SESSION, cwd: "/tmp" });
		const attachment = await backend.attachView(SESSION);
		await attachment.write("hi\r");
		await backend.dispose();
		expect(world.closedClients).toContain(SESSION);
		expect(world.sessions.has(SESSION)).toBe(true);
	});
});
