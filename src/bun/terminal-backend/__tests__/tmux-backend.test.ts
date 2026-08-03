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

// ── Read-only capture (seq 1412) ──────────────────────────────────────────────

describe("TmuxTerminalBackend read-only capture", () => {
	it("reports history as absent by nature while a full-screen program owns the pane", async () => {
		const { world, backend } = harness();
		const created = await backend.openSession({ id: SESSION, cwd: "/tmp" });
		const view = created.views[0].id;
		const attachment = await backend.attachView(SESSION);
		for (let i = 0; i < 40; i++) await attachment.write(`line-${i}\r`);
		world.enterAlternateScreen(view);

		const capture = await backend.captureView(SESSION, view, { historyLines: 100 });
		if (capture.availability !== "captured") throw new Error(capture.reason);
		expect(capture.screen).toEqual({ known: true, value: "alternate" });
		// The scrollback behind a TUI is not recent output, so it is not offered as
		// history — and the absence is not reported as truncation either.
		expect(capture.content.history).toEqual([]);
		expect(capture.bounds.historyLinesAvailable).toEqual({ known: true, value: 0 });
		expect(capture.issues.map((issue) => issue.code)).not.toContain("history-truncated");
	});

	it("says plainly that tmux cannot account for dropped output or a reset", async () => {
		const { backend } = harness();
		const created = await backend.openSession({ id: SESSION, cwd: "/tmp" });
		const capture = await backend.captureView(SESSION, created.views[0].id);
		if (capture.availability !== "captured") throw new Error(capture.reason);
		expect(capture.gaps.known).toBe(false);
		expect(capture.issues.some((issue) => issue.code === "unknown")).toBe(true);
		// tmux has no pane-set generation, so an epoch here would be invented.
		expect(capture.identity.epoch.known).toBe(false);
	});

	it("does not compare equal across a server restart that reuses the pane id and pid", async () => {
		const { world, backend } = harness();
		const created = await backend.openSession({ id: SESSION, cwd: "/tmp" });
		const view = created.views[0].id;
		const before = await backend.captureView(SESSION, view);
		// Same pane id, same pid, different tmux server — pane ids begin again after
		// a restart, so the id and pid alone would call this the same pane.
		world.serverEpoch += 1;
		const after = await backend.captureView(SESSION, view);
		expect(before.identity.incarnation.known && after.identity.incarnation.known).toBe(true);
		if (!before.identity.incarnation.known || !after.identity.incarnation.known) return;
		expect(after.identity.incarnation.value).not.toBe(before.identity.incarnation.value);
	});

	it("reports a pane replaced mid-capture instead of returning its successor's screen", async () => {
		const world = new FakeTmuxWorld();
		const port = world.port();
		let paneId = "";
		const backend = new TmuxTerminalBackend({
			port: {
				...port,
				async capturePane(target, historyLines) {
					// The pane's process is swapped exactly between the two identity checks.
					if (target === paneId) world.replacePaneProcess(target);
					return port.capturePane(target, historyLines);
				},
			},
		});
		const created = await backend.openSession({ id: SESSION, cwd: "/tmp" });
		paneId = created.views[0].id;

		const capture = await backend.captureView(SESSION, paneId);
		expect(capture.availability).toBe("replaced");
		if (capture.availability === "captured") throw new Error("must not carry content");
		expect(capture.reason).toContain("incarnation changed");
	});

	it("reports a pane that vanished mid-capture as view-absent, not as a tmux failure", async () => {
		const world = new FakeTmuxWorld();
		const port = world.port();
		let paneId = "";
		const backend = new TmuxTerminalBackend({
			port: {
				...port,
				async capturePane(target, historyLines) {
					if (target === paneId) world.killPaneProcess(target);
					return port.capturePane(target, historyLines);
				},
			},
		});
		const created = await backend.openSession({ id: SESSION, cwd: "/tmp" });
		paneId = created.views[0].id;

		const capture = await backend.captureView(SESSION, paneId);
		expect(capture.availability).toBe("view-absent");
	});

	it("reports a rejected hasSession as unreadable, never as session-absent", async () => {
		const world = new FakeTmuxWorld();
		const backend = new TmuxTerminalBackend({
			port: { ...world.port(), hasSession: () => Promise.reject(new Error("no server running")) },
		});
		const capture = await backend.captureView(SESSION, "%0");
		expect(capture.availability).toBe("unreadable");
		if (capture.availability === "captured") throw new Error("must not carry content");
		expect(capture.reason).toContain("no server running");
	});

	it("keeps the viewport and the history contiguous when output lands mid-capture", async () => {
		const world = new FakeTmuxWorld();
		const port = world.port();
		let paneId = "";
		const backend = new TmuxTerminalBackend({
			port: {
				...port,
				async capturePane(target, historyLines) {
					const captured = await port.capturePane(target, historyLines);
					// Output arriving at the OLD two-call boundary: with two independent
					// reads this shifted the split and duplicated or dropped a row.
					if (target === paneId) await port.writePane(target, "late-row\r");
					return captured;
				},
			},
		});
		const created = await backend.openSession({ id: SESSION, cwd: "/tmp" });
		paneId = created.views[0].id;
		const attachment = await backend.attachView(SESSION, paneId);
		for (let i = 0; i < 40; i++) await attachment.write(`row-${i}\r`);

		const capture = await backend.captureView(SESSION, paneId, { historyLines: 100 });
		if (capture.availability !== "captured") throw new Error(capture.reason);
		const rows = [...capture.content.history, ...capture.content.viewport].filter((row) => row.trim() !== "");
		// Every row appears exactly once, and the sequence has no hole.
		expect(new Set(rows).size).toBe(rows.length);
		const numbers = rows.filter((row) => row.startsWith("row-")).map((row) => Number(row.slice(4)));
		for (let i = 1; i < numbers.length; i++) expect(numbers[i]).toBe(numbers[i - 1]! + 1);
	});

	it("reports a tmux read failure as unreadable rather than throwing at a caller", async () => {
		const world = new FakeTmuxWorld();
		const backend = new TmuxTerminalBackend({
			port: { ...world.port(), observePane: () => Promise.reject(new Error("list-panes exploded")) },
		});
		await backend.openSession({ id: SESSION, cwd: "/tmp" });
		const state = await backend.describeSession(SESSION);
		const capture = await backend.captureView(SESSION, state!.views[0].id);
		expect(capture.availability).toBe("unreadable");
		if (capture.availability === "captured") throw new Error("must not carry content");
		expect(capture.reason).toContain("list-panes exploded");
	});
});
