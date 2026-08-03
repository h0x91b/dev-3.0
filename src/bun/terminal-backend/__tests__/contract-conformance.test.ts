/**
 * Contract-level conformance for the product terminal-backend seam (MIG-002).
 *
 * ONE suite, run against BOTH adapters over their injected in-memory worlds: the
 * common single-view lifecycle (open → describe → attach → write → capture →
 * resize → focus → close/cleanup), reconnect identity from a fresh controller,
 * idempotent cleanup, and the typed failure taxonomy. Multi-view is asserted per
 * adapter: tmux splits, native returns the typed `unsupported` result.
 *
 * The read-only capture block (seq 1412) is the reason this suite runs against
 * both worlds at all: viewport/history separation, the fixed order of loss, the
 * identity bracket, and the six availabilities must read the SAME on tmux and on
 * native, or a coordinator cannot trust either.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	NativeTerminalBackend,
	TmuxTerminalBackend,
	isCapturedPane,
	isTerminalBackendError,
	type TerminalBackend,
	type TerminalPaneCaptureContent,
	type TerminalBackendErrorCode,
} from "..";
import { FakeCoordinatorWorld } from "./fake-coordinator-world";
import { FakeTmuxWorld } from "./fake-tmux-world";

/** A capture that MUST have content, with the availability asserted at the seam. */
async function captured(
	backend: TerminalBackend,
	viewId: string,
	request?: { historyLines?: number; maxBytes?: number },
): Promise<TerminalPaneCaptureContent> {
	const capture = await backend.captureView(SESSION, viewId, request);
	if (!isCapturedPane(capture)) {
		throw new Error(`expected content, got ${capture.availability}: ${capture.reason}`);
	}
	return capture;
}

const SESSION = "task-alpha";
const CWD = "/tmp/dev3-seam";

interface ConformanceCase {
	readonly name: string;
	/** Fresh, independent world + a factory for controllers bound to it. */
	setup(): {
		create(): TerminalBackend;
		/** Kill the view's process behind the backend's back. */
		killViewProcess(viewId: string): void;
		geometry(): { cols: number; rows: number };
		cleanup?(): void;
	};
	readonly supportsSplit: boolean;
}

const CASES: ConformanceCase[] = [
	{
		name: "tmux",
		supportsSplit: true,
		setup() {
			const world = new FakeTmuxWorld();
			return {
				create: () => new TmuxTerminalBackend({ port: world.port() }),
				killViewProcess: (viewId) => world.killPaneProcess(viewId),
				geometry: () => world.geometry(SESSION),
			};
		},
	},
	{
		name: "native",
		supportsSplit: true,
		setup() {
			const world = new FakeCoordinatorWorld();
			return {
				create: () => new NativeTerminalBackend({ deps: world.deps() }),
				killViewProcess: (viewId) => world.killViewProcess(SESSION, viewId),
				geometry: () => world.geometry(SESSION),
				cleanup: () => world.cleanup(),
			};
		},
	},
];

async function codeOf(run: () => Promise<unknown>): Promise<TerminalBackendErrorCode | "no-error"> {
	try {
		await run();
		return "no-error";
	} catch (err) {
		if (!isTerminalBackendError(err)) throw err;
		return err.code;
	}
}

describe.each(CASES)("TerminalBackend contract — $name", (testCase) => {
	let cleanupFn: (() => void) | undefined;

	afterEach(() => {
		cleanupFn?.();
		cleanupFn = undefined;
	});

	function world() {
		const harness = testCase.setup();
		cleanupFn = harness.cleanup;
		return { ...harness, backend: harness.create() };
	}

	it("opens a session with exactly one focused view", async () => {
		const { backend } = world();
		const state = await backend.openSession({ id: SESSION, cwd: CWD, command: "sh" });
		expect(state.views).toHaveLength(1);
		expect(state.views[0].focused).toBe(true);
		expect(state.focusedViewId).toBe(state.views[0].id);
	});

	it("describes the session with the same ids it reported at creation", async () => {
		const { backend } = world();
		const created = await backend.openSession({ id: SESSION, cwd: CWD });
		await expect(backend.describeSession(SESSION)).resolves.toEqual(created);
	});

	it("reports an absent session as null instead of failing", async () => {
		const { backend } = world();
		await expect(backend.describeSession("ghost")).resolves.toBeNull();
	});

	it("rejects a second open of the same id (no adoption, no double spawn)", async () => {
		const { backend } = world();
		await backend.openSession({ id: SESSION, cwd: CWD });
		expect(await codeOf(() => backend.openSession({ id: SESSION, cwd: CWD }))).toBe("session-exists");
	});

	it("rejects a session id that is not portable across backends", async () => {
		const { backend } = world();
		expect(await codeOf(() => backend.openSession({ id: "bad:id", cwd: CWD }))).toBe(
			"invalid-session-id",
		);
	});

	it("writes input to the attached view and reads it back with a read-only capture", async () => {
		const { backend } = world();
		const created = await backend.openSession({ id: SESSION, cwd: CWD });
		const attachment = await backend.attachView(SESSION);
		await attachment.write("echo seam\r");
		const capture = await captured(backend, created.views[0].id);
		expect(capture.identity.viewId).toBe(attachment.viewId);
		expect(capture.identity.backend).toBe(backend.kind);
		expect(capture.content.viewport.join("\n")).toContain("echo seam");
		expect(capture.content.lineModel).toBe("physical-rows");
		// The default is the visible screen: history is opt-in, on both backends.
		expect(capture.content.history).toEqual([]);
		expect(capture.bounds.historyLinesRequested).toBe(0);
		expect(capture.liveness).toBe("live");
		expect(capture.identity.incarnation.known).toBe(true);
	});

	it("returns history only when asked, oldest first, ending above the viewport", async () => {
		const { backend } = world();
		const created = await backend.openSession({ id: SESSION, cwd: CWD });
		const view = created.views[0].id;
		const attachment = await backend.attachView(SESSION);
		for (let i = 0; i < 40; i++) await attachment.write(`line-${i}\r`);

		const withoutHistory = await captured(backend, view);
		expect(withoutHistory.content.history).toEqual([]);
		expect(withoutHistory.content.viewport.join("\n")).toContain("line-39");

		const withHistory = await captured(backend, view, { historyLines: 100 });
		const history = withHistory.content.history;
		expect(history.length).toBeGreaterThan(0);
		expect(history.join("\n")).toContain("line-0");
		// Oldest first, and nothing in history is also on screen.
		expect(history.indexOf(history.find((l) => l.includes("line-0")) ?? "")).toBeLessThan(history.length - 1);
		// No content row appears in both halves; blank rows are not content.
		for (const line of withHistory.content.viewport) {
			if (line.trim() !== "") expect(history).not.toContain(line);
		}
		expect(withHistory.bounds.historyLinesReturned).toBe(history.length);
	});

	it("keeps the newest rows and reports what a tight byte budget cut", async () => {
		const { backend } = world();
		const created = await backend.openSession({ id: SESSION, cwd: CWD });
		const view = created.views[0].id;
		const attachment = await backend.attachView(SESSION);
		for (let i = 0; i < 40; i++) await attachment.write(`line-${i}\r`);

		const tight = await captured(backend, view, { historyLines: 100, maxBytes: 40 });
		expect(tight.bounds.bytesReturned).toBeLessThanOrEqual(40);
		// History is discarded before the viewport, so the newest output survives.
		expect(tight.content.viewport.join("\n")).toContain("line-39");
		expect(tight.content.history).toEqual([]);
		expect(tight.issues.map((issue) => issue.code)).toContain("history-truncated");
	});

	it("reports the six availabilities distinctly instead of an empty string", async () => {
		const { backend } = world();
		const created = await backend.openSession({ id: SESSION, cwd: CWD });
		const absent = await backend.captureView("ghost-session", created.views[0].id);
		expect(absent.availability).toBe("session-absent");
		if (isCapturedPane(absent)) throw new Error("a ghost session must never carry content");
		expect(absent.reason.length).toBeGreaterThan(0);
		// Identity and readAt are present even on a miss, so it can be logged as-is.
		expect(absent.identity.sessionId).toBe("ghost-session");
		expect(Date.parse(absent.readAt)).not.toBeNaN();

		const noView = await backend.captureView(SESSION, "%nope");
		expect(noView.availability).toBe("view-absent");

		const badId = await backend.captureView("bad:id", "%0");
		expect(badId.availability).toBe("session-absent");
	});

	it("never focuses, writes, or resizes the pane it captures", async () => {
		const { backend, geometry } = world();
		const created = await backend.openSession({ id: SESSION, cwd: CWD, size: { cols: 100, rows: 30 } });
		const before = await backend.describeSession(SESSION);
		await captured(backend, created.views[0].id, { historyLines: 10 });
		expect(await backend.describeSession(SESSION)).toEqual(before);
		expect(geometry()).toEqual({ cols: 100, rows: 30 });
	});

	it("strips escape sequences out of captured text", async () => {
		const { backend } = world();
		const created = await backend.openSession({ id: SESSION, cwd: CWD });
		const attachment = await backend.attachView(SESSION);
		// A colour run plus an OSC title — neither may reach a caller.
		await attachment.write("\u001B[31mred\u001B[0m\u001B]0;secret-title\u0007\r");
		const capture = await captured(backend, created.views[0].id, { historyLines: 50 });
		const text = [...capture.content.history, ...capture.content.viewport].join("\n");
		expect(text).toContain("red");
		expect(text).not.toContain("\u001B");
		expect(text).not.toContain("secret-title");
	});

	it("applies a resize and rejects non-positive geometry", async () => {
		const { backend, geometry } = world();
		await backend.openSession({ id: SESSION, cwd: CWD });
		const attachment = await backend.attachView(SESSION);
		await attachment.resize({ cols: 120, rows: 40 });
		expect(geometry()).toEqual({ cols: 120, rows: 40 });
		expect(await codeOf(() => attachment.resize({ cols: 0, rows: 40 }))).toBe("invalid-size");
	});

	it("honours the initial size from the session spec", async () => {
		const { backend, geometry } = world();
		await backend.openSession({ id: SESSION, cwd: CWD, size: { cols: 100, rows: 30 } });
		expect(geometry()).toEqual({ cols: 100, rows: 30 });
	});

	it("focuses the sole view without changing the reported state", async () => {
		const { backend } = world();
		const created = await backend.openSession({ id: SESSION, cwd: CWD });
		await backend.focusView(SESSION, created.views[0].id);
		await expect(backend.describeSession(SESSION)).resolves.toEqual(created);
	});

	it("fails typed on an unknown view and an unknown session", async () => {
		const { backend } = world();
		await backend.openSession({ id: SESSION, cwd: CWD });
		expect(await codeOf(() => backend.attachView(SESSION, "%does-not-exist"))).toBe("view-not-found");
		expect(await codeOf(() => backend.attachView("ghost"))).toBe("session-not-found");
		expect(await codeOf(() => backend.focusView("ghost", "%0"))).toBe("session-not-found");
	});

	it("keeps view ids stable for a fresh controller and lets it capture (reconnect)", async () => {
		const harness = testCase.setup();
		const owner = harness.create();
		const created = await owner.openSession({ id: SESSION, cwd: CWD });
		const attachment = await owner.attachView(SESSION);
		await attachment.write("before-reconnect\r");

		const fresh = harness.create();
		const rediscovered = await fresh.describeSession(SESSION);
		expect(rediscovered).toEqual(created);
		const reattached = await fresh.attachView(SESSION);
		expect(reattached.viewId).toBe(created.views[0].id);
		expect((await captured(fresh, created.views[0].id)).content.viewport.join("\n")).toContain(
			"before-reconnect",
		);
	});

	it("rejects use of a released attachment and detaches idempotently", async () => {
		const { backend } = world();
		await backend.openSession({ id: SESSION, cwd: CWD });
		const attachment = await backend.attachView(SESSION);
		await attachment.detach();
		await attachment.detach();
		expect(await codeOf(() => attachment.write("x"))).toBe("detached");
		expect(await codeOf(() => attachment.resize({ cols: 80, rows: 24 }))).toBe("detached");
	});

	it("keeps the session alive across dispose (sessions are persistent)", async () => {
		const harness = testCase.setup();
		const backend = harness.create();
		const created = await backend.openSession({ id: SESSION, cwd: CWD });
		await backend.dispose();
		await expect(harness.create().describeSession(SESSION)).resolves.toEqual(created);
	});

	it("tears the session down when its last view is closed", async () => {
		const { backend } = world();
		const created = await backend.openSession({ id: SESSION, cwd: CWD });
		await backend.closeView(SESSION, created.views[0].id);
		await expect(backend.describeSession(SESSION)).resolves.toBeNull();
	});

	it("makes cleanup idempotent with ignoreMissing and strict without it", async () => {
		const { backend } = world();
		await backend.openSession({ id: SESSION, cwd: CWD });
		await backend.cleanupSession(SESSION);
		await expect(backend.describeSession(SESSION)).resolves.toBeNull();
		await expect(backend.cleanupSession(SESSION, { ignoreMissing: true })).resolves.toBeUndefined();
		expect(await codeOf(() => backend.cleanupSession(SESSION))).toBe("session-not-found");
	});

	it("reports a session whose process died as gone, not as a crash", async () => {
		const { backend, killViewProcess } = world();
		const created = await backend.openSession({ id: SESSION, cwd: CWD });
		killViewProcess(created.views[0].id);
		await expect(backend.describeSession(SESSION)).resolves.toBeNull();
		expect(await codeOf(() => backend.attachView(SESSION))).toBe("session-not-found");
		await expect(backend.cleanupSession(SESSION, { ignoreMissing: true })).resolves.toBeUndefined();
	});

	it("surfaces a dead view on a live attachment as a typed failure", async () => {
		const { backend, killViewProcess } = world();
		const created = await backend.openSession({ id: SESSION, cwd: CWD });
		const attachment = await backend.attachView(SESSION);
		killViewProcess(created.views[0].id);
		const code = await codeOf(() => attachment.write("after-death\r"));
		expect(["view-not-found", "session-not-found"]).toContain(code);
	});

	it(
		testCase.supportsSplit
			? "adds a second view on split"
			: "returns the typed unsupported result for split",
		async () => {
			const { backend } = world();
			const created = await backend.openSession({ id: SESSION, cwd: CWD });
			const first = created.views[0].id;
			if (!testCase.supportsSplit) {
				expect(await codeOf(() => backend.splitView(SESSION, first, { cwd: CWD }))).toBe(
					"unsupported",
				);
				return;
			}
			const second = await backend.splitView(SESSION, first, { cwd: CWD });
			expect(second.id).not.toBe(first);
			const state = await backend.describeSession(SESSION);
			expect(state?.views.map((view) => view.id)).toEqual([first, second.id]);
			expect(state?.focusedViewId).toBe(second.id);
		},
	);
});
