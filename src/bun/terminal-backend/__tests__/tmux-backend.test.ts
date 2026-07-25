/**
 * tmux-adapter specifics the shared conformance suite cannot express: multi-view
 * focus bookkeeping, best-effort teardown of an unknown view, and the wrapping
 * of a tmux-side failure that is NOT a missing view.
 */

import { describe, expect, it } from "vitest";
import { TmuxTerminalBackend } from "../tmux-backend";
import { isTerminalBackendError, TerminalBackendError } from "../errors";
import { FakeTmuxWorld } from "./fake-tmux-world";

const SESSION = "task-tmux";

function harness() {
	const world = new FakeTmuxWorld();
	return { world, backend: new TmuxTerminalBackend({ port: world.port() }) };
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

describe("TmuxTerminalBackend", () => {
	it("reports the tmux backend kind", () => {
		expect(harness().backend.kind).toBe("tmux");
	});

	it("moves focus between views and reports exactly one focused view", async () => {
		const { backend } = harness();
		const created = await backend.openSession({ id: SESSION, cwd: "/tmp" });
		const first = created.views[0].id;
		const second = await backend.splitView(SESSION, first, { cwd: "/tmp" });
		await backend.focusView(SESSION, first);
		const state = await backend.describeSession(SESSION);
		expect(state?.focusedViewId).toBe(first);
		expect(state?.views.filter((view) => view.focused)).toHaveLength(1);
		expect(second.focused).toBe(true);
	});

	it("keeps the session alive when one of two views is closed", async () => {
		const { backend } = harness();
		const created = await backend.openSession({ id: SESSION, cwd: "/tmp" });
		const second = await backend.splitView(SESSION, created.views[0].id, { cwd: "/tmp" });
		await backend.closeView(SESSION, second.id);
		const state = await backend.describeSession(SESSION);
		expect(state?.views.map((view) => view.id)).toEqual([created.views[0].id]);
	});

	it("ignores closing an unknown view only when asked to", async () => {
		const { backend } = harness();
		await backend.openSession({ id: SESSION, cwd: "/tmp" });
		await expect(backend.closeView(SESSION, "%404", { ignoreMissing: true })).resolves.toBeUndefined();
		expect(await code(() => backend.closeView(SESSION, "%404"))).toBe("view-not-found");
	});

	it("wraps a tmux failure on a live view as backend-failure with its cause", async () => {
		const world = new FakeTmuxWorld();
		const port = world.port();
		const boom = new Error("tmux send-keys failed");
		const backend = new TmuxTerminalBackend({
			port: { ...port, writePane: () => Promise.reject(boom) },
		});
		await backend.openSession({ id: SESSION, cwd: "/tmp" });
		const attachment = await backend.attachView(SESSION);
		const err = await attachment.write("hi\r").catch((e) => e);
		expect(err).toBeInstanceOf(TerminalBackendError);
		expect(err.code).toBe("backend-failure");
		expect(err.cause).toBe(boom);
	});

	it("never lets a tmux error escape the seam untyped", async () => {
		const world = new FakeTmuxWorld();
		const backend = new TmuxTerminalBackend({
			port: { ...world.port(), hasSession: () => Promise.reject(new Error("no server running")) },
		});
		const err = await backend.openSession({ id: SESSION, cwd: "/tmp" }).catch((e) => e);
		expect(isTerminalBackendError(err)).toBe(true);
		expect(err.code).toBe("backend-failure");
	});
});
