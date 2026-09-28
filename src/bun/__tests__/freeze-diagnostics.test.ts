import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, statSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFreezeMonitor } from "../freeze-diagnostics/monitor";
import { createCaptureStore, createStackCapture, rendererPids } from "../freeze-diagnostics/capture";
import {
	applyFreezeDiagnosticsSetting,
	configureFreezeDiagnostics,
	freezeBeat,
	freezeDiagnosticsDirectory,
	freezeDiagnosticsRunning,
	freezeDiagnosticsSupported,
	pinPtyOutputIfStale,
	recordFreezeDiagnostic,
	stopFreezeDiagnostics,
	writePtyOutput,
} from "../freeze-diagnostics";
import { wantsPtyOutput, type FreezeBeat, type PtyOutputRequest } from "../freeze-diagnostics/protocol";
import { createPtyOutputRecorder, PTY_OUTPUT_PIN_AFTER_MS, ptyOutputRecorder } from "../freeze-diagnostics/pty-output";

const logRoot = vi.hoisted(() => ({ path: "/unused" }));
vi.mock("../logger", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }), getLogPath: () => logRoot.path }));
const beat: FreezeBeat = { clientId: "page-a", visible: true, sinceLastBeatMs: 2_000, hiddenSinceLastBeat: false, terminals: 1, frameErrorPanes: 0 };
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
	const monitor = createFreezeMonitor(0);
	monitor.receive({ kind: "window", windowId: 1, event: "created" }, 0);
	for (let at = 0; at <= 22_000; at += 1_000) {
		monitor.receive({ kind: "host" }, at);
		monitor.receive({ kind: "beat", windowId: 1, beat }, at);
		monitor.check(at);
	}
	return monitor;
}

describe("opt-in local freeze diagnostics", () => {
	it("can only record on macOS", () => {
		expect(freezeDiagnosticsSupported("darwin")).toBe(true);
		expect(freezeDiagnosticsSupported("linux")).toBe(false);
		expect(freezeDiagnosticsSupported("win32")).toBe(false);
	});
	it("starts and stops the collector with the saved setting, on every platform the same way", () => {
		const dir = mkdtempSync(join(tmpdir(), "dev3-freeze-toggle-"));
		directories.push(dir);
		const workerPath = join(dir, "worker.mjs");
		// A worker that only stays alive: this proves the lifecycle, not the sampler.
		writeFileSync(workerPath, "import { parentPort } from 'node:worker_threads';\nparentPort?.on('message', () => {});\n");

		// Nothing is configured yet, so an enabled setting cannot start anything.
		applyFreezeDiagnosticsSetting(true, "darwin");
		expect(freezeDiagnosticsRunning()).toBe(false);

		configureFreezeDiagnostics({ workerPath, version: "test", build: "test" });
		try {
			// An unsupported host ignores the setting instead of half-starting.
			applyFreezeDiagnosticsSetting(true, "linux");
			expect(freezeDiagnosticsRunning()).toBe(false);
			applyFreezeDiagnosticsSetting(true, "win32");
			expect(freezeDiagnosticsRunning()).toBe(false);

			applyFreezeDiagnosticsSetting(true, "darwin");
			expect(freezeDiagnosticsRunning()).toBe(true);
			// Saving the settings again must not stack a second collector.
			applyFreezeDiagnosticsSetting(true, "darwin");
			expect(freezeDiagnosticsRunning()).toBe(true);

			applyFreezeDiagnosticsSetting(false, "darwin");
			expect(freezeDiagnosticsRunning()).toBe(false);
			// Turning it off stops future collection: a beat now reaches nobody.
			expect(() => recordFreezeDiagnostic({ kind: "host" })).not.toThrow();

			// And it can come back on in the same session, without a restart.
			applyFreezeDiagnosticsSetting(true, "darwin");
			expect(freezeDiagnosticsRunning()).toBe(true);
		} finally {
			stopFreezeDiagnostics();
		}
		expect(freezeDiagnosticsRunning()).toBe(false);
	});
	it("ignores a missing worker asset instead of reporting a live collector", () => {
		configureFreezeDiagnostics({ workerPath: join(tmpdir(), "dev3-freeze-absent.mjs"), version: "test", build: "test" });
		applyFreezeDiagnosticsSetting(true, "darwin");
		expect(freezeDiagnosticsRunning()).toBe(false);
	});
	it("copies only structural heartbeat fields", () => {
		const safe = freezeBeat({ ...beat, prompt: "secret", viewport: { width: 100, height: 200, dpr: 2, title: "secret" } } as FreezeBeat);
		expect(JSON.stringify(safe)).not.toContain("secret");
		expect(safe.viewport).toEqual({ width: 100, height: 200, dpr: 2 });
	});
	it("catches a blocked host while its independent observer keeps ticking", () => {
		const monitor = fixture();
		for (let at = 23_000; at < 27_000; at += 1_000) expect(monitor.check(at).capture).toBeNull();
		expect(monitor.check(27_000).capture?.reasons).toContain("host-heartbeat-missing");
	});
	it("catches a renderer that remained hidden across sleep then receives native focus", () => {
		const monitor = fixture();
		monitor.receive({ kind: "beat", windowId: 1, beat: { ...beat, visible: false } }, 22_000);
		expect(monitor.check(400_000).capture).toBeNull();
		monitor.receive({ kind: "window", windowId: 1, event: "focus" }, 400_000);
		for (let at = 401_000; at < 420_000; at += 1_000) {
			monitor.receive({ kind: "host" }, at);
			expect(monitor.check(at).capture).toBeNull();
		}
		monitor.receive({ kind: "host" }, 420_000);
		expect(monitor.check(420_000).capture?.reasons).toEqual(["window-1-heartbeat-missing"]);
		expect(monitor.snapshot(420_000).windows[0]!.beatAgeMs).toBe(398_000);
	});
	it("does not call healthy sleep, a background window, or a closed window a stall", () => {
		const monitor = fixture();
		monitor.receive({ kind: "beat", windowId: 1, beat: { ...beat, visible: false } }, 22_000);
		expect(monitor.check(400_000).observerGapMs).toBe(378_000);
		for (let at = 401_000; at <= 430_000; at += 1_000) {
			monitor.receive({ kind: "host" }, at);
			expect(monitor.check(at).capture).toBeNull();
		}
		monitor.receive({ kind: "window", windowId: 1, event: "closed" }, 430_000);
		expect(monitor.snapshot(430_000).windows).toEqual([]);
	});
	it("records fresh JS beats whose animation frame has stopped", () => {
		const monitor = fixture();
		monitor.receive({ kind: "host" }, 23_000);
		monitor.receive({ kind: "beat", windowId: 1, beat: { ...beat, animationFrameAgeMs: 15_000 } }, 23_000);
		expect(monitor.check(23_000).capture?.reasons).toEqual(["window-1-animation-frame-missing"]);
	});
	it("limits repeated sampling and bounds the history", () => {
		const monitor = fixture();
		let captures = 0;
		for (let at = 23_000; at <= 1_500_000; at += 1_000) {
			monitor.receive({ kind: "display", reason: "displays" }, at);
			if (monitor.check(at).capture) captures++;
		}
		expect(captures).toBe(3);
		expect(monitor.snapshot(1_500_000).history).toHaveLength(60);
	});
	it("attributes only native WebKit process messages from this host", () => {
		expect(rendererPids([
			"2026-09-16 10:00:00.000 Df bun[12:abcd] [com.apple.WebKit:Process] [PID=100] WebProcessProxy::didFinishLaunching:",
			"2026-09-16 10:00:00.000 Df bun[13:abcd] [com.apple.WebKit:Process] [PID=101] WebProcessProxy::didFinishLaunching:",
			"2026-09-16 10:00:00.000 Df bun[12:abcd] [some-other-subsystem] [PID=102] WebProcessProxy::didFinishLaunching:",
			"2026-09-16 10:00:00.000 Df bun[12:abcd] [com.apple.WebKit:Process] [PID=0] WebProcessProxy::constructor:",
		].join("\n"), 12)).toEqual([{ pid: 100, seenAt: new Date("2026-09-16T10:00:00.000").getTime() }]);
	});
	it("samples only verified cached identities and rejects PID reuse", async () => {
		const saved = vi.fn();
		let reused = false;
		const run = vi.fn(async (file: string, args: string[]) => {
			if (file.endsWith("/log")) return { ok: true, output: "2026-09-16 10:00:00.000 Df bun[12:aa] [com.apple.WebKit:Process] [PID=100] WebProcessProxy::didFinishLaunching:" };
			if (file.endsWith("/ps")) return { ok: true, output: `${reused ? "Wed Sep 16 10:01:00 2026" : "Wed Sep 16 09:00:00 2026"} /System/com.apple.WebKit.WebContent` };
			return { ok: true, output: `stack ${args[0]}` };
		});
		const capture = createStackCapture(12, saved, run);
		await capture.discover();
		await capture.capture(1);
		expect(saved).toHaveBeenCalledWith("1-renderer-100", "stack 100");
		reused = true;
		await capture.discover();
		const second = await capture.capture(2);
		expect(second).toContainEqual({ pid: 100, skipped: "identity-changed-or-exited" });
		expect(saved).not.toHaveBeenCalledWith("2-renderer-100", expect.anything());
	});
	it("keeps the host sample when renderer discovery is unavailable", async () => {
		const saved = vi.fn();
		const run = vi.fn(async (file: string) => file.endsWith("/sample") ? { ok: true, output: "host stack" } : { ok: false, output: "" });
		await createStackCapture(12, saved, run).capture(1);
		expect(saved).toHaveBeenCalledWith("1-host", "host stack");
	});

	it("rotates a bounded journal so a later incident still gets recorded", () => {
		const dir = mkdtempSync(join(tmpdir(), "dev3-freeze-journal-"));
		directories.push(dir);
		const store = createCaptureStore(dir, "freeze-1-10");
		for (let i = 0; i < 3; i++) store.log({ padding: "x".repeat(900_000) });
		store.log({ event: "suspected-stall" });
		expect(readFileSync(join(dir, "freeze-1-10.jsonl"), "utf8")).toContain("suspected-stall");
		for (const name of readdirSync(dir)) expect(statSync(join(dir, name)).size).toBeLessThanOrEqual(2 * 1024 * 1024);
	});

	it("retains five sessions and bounds files without touching unrelated logs", () => {
		const dir = mkdtempSync(join(tmpdir(), "dev3-freeze-store-"));
		directories.push(dir);
		writeFileSync(join(dir, "keep.log"), "user content");
		for (let i = 1; i <= 6; i++) {
			const store = createCaptureStore(dir, `freeze-${i}-10`);
			store.log({ event: "started" });
			store.save("1-host", "sample");
		}
		expect(readdirSync(dir).filter((name) => name.endsWith("jsonl"))).toHaveLength(5);
		expect(readFileSync(join(dir, "keep.log"), "utf8")).toBe("user content");
	});

	it("rotates terminal-output dumps with the rest of their session", () => {
		const dir = mkdtempSync(join(tmpdir(), "dev3-freeze-pty-rotate-"));
		directories.push(dir);
		for (let i = 1; i <= 6; i++) {
			createCaptureStore(dir, `freeze-${i}-10`).log({ event: "started" });
			writeFileSync(join(dir, `freeze-${i}-10.1-pty.json`), "{}");
		}
		expect(readdirSync(dir).filter((name) => name.endsWith("-pty.json")).sort()).toEqual(
			[2, 3, 4, 5, 6].map((i) => `freeze-${i}-10.1-pty.json`),
		);
	});
});

describe("recent terminal output for a stuck renderer", () => {
	const request: PtyOutputRequest = { event: "capture-pty-output", session: "freeze-1-10", number: 2, reasons: ["window-1-heartbeat-missing"] };
	afterEach(() => {
		stopFreezeDiagnostics();
		ptyOutputRecorder.setEnabled(false);
		logRoot.path = "/unused";
	});

	it("keeps nothing unless freeze capture turned it on, and drops everything when it turns off", () => {
		const recorder = createPtyOutputRecorder();
		const client = {};
		recorder.record(client, "task", "secret output");
		expect(recorder.snapshot()).toEqual([]);
		recorder.setEnabled(true);
		recorder.record(client, "task", "kept");
		expect(recorder.snapshot()).toHaveLength(1);
		recorder.setEnabled(false);
		expect(recorder.snapshot()).toEqual([]);
	});

	it("bounds each client to the newest output and counts what it dropped", () => {
		const recorder = createPtyOutputRecorder({ ringChars: 10, maxClients: 4 });
		recorder.setEnabled(true);
		const client = {};
		for (const [at, text] of [[1, "aaaa"], [2, "bbbb"], [3, "cccc"]] as const) recorder.record(client, "task", text, at);
		const [record] = recorder.snapshot();
		expect(record!.chunks).toEqual([{ at: 2, text: "bbbb" }, { at: 3, text: "cccc" }]);
		expect(record).toMatchObject({ sentChars: 12, droppedChars: 4, firstAt: 1, lastAt: 3 });
		// One chunk bigger than the whole ring keeps its tail, and says so.
		recorder.record(client, "task", "0123456789XYZ", 4);
		expect(recorder.snapshot()[0]!.chunks).toEqual([{ at: 4, text: "3456789XYZ" }]);
		expect(recorder.snapshot()[0]!.droppedChars).toBe(4 + 3 + 8);
	});

	it("bounds the number of clients by dropping the one written longest ago, and forgets a closed one", () => {
		const recorder = createPtyOutputRecorder({ ringChars: 10, maxClients: 2 });
		recorder.setEnabled(true);
		const [a, b, c] = [{}, {}, {}];
		recorder.record(a, "a", "x", 1);
		recorder.record(b, "b", "x", 2);
		recorder.record(a, "a", "y", 3);
		recorder.record(c, "c", "x", 4);
		expect(recorder.snapshot().map((r) => r.sessionKey)).toEqual(["c", "a"]);
		recorder.forget(c);
		expect(recorder.snapshot().map((r) => r.sessionKey)).toEqual(["a"]);
	});

	it("pins the ring when a window's heartbeat goes stale, so later output cannot evict it", () => {
		const recorder = createPtyOutputRecorder({ ringChars: 8, maxClients: 4 });
		recorder.setEnabled(true);
		const client = {};
		recorder.record(client, "task", "trigger", 1);
		recorder.pin(10);
		for (let at = 11; at < 20; at++) recorder.record(client, "task", "later", at);
		recorder.pin(30);
		const [record] = recorder.snapshot();
		expect(record!.pinned).toEqual({ at: 10, chunks: [{ at: 1, text: "trigger" }] });
		expect(record!.chunks.map((chunk) => chunk.text).join("")).not.toContain("trigger");
		recorder.unpin();
		expect(recorder.snapshot()[0]!.pinned).toBeNull();
	});

	it("pins only after a desktop window has gone two hidden beats without one", () => {
		const dir = mkdtempSync(join(tmpdir(), "dev3-freeze-pin-"));
		directories.push(dir);
		const workerPath = join(dir, "worker.mjs");
		writeFileSync(workerPath, "import { parentPort } from 'node:worker_threads';\nparentPort?.on('message', () => {});\n");
		configureFreezeDiagnostics({ workerPath, version: "test", build: "test" });
		applyFreezeDiagnosticsSetting(true, "darwin");
		expect(ptyOutputRecorder.isEnabled()).toBe(true);
		const client = {};
		ptyOutputRecorder.record(client, "task", "trigger", 1_000);
		recordFreezeDiagnostic({ kind: "beat", windowId: 1, beat }, 1_000);
		pinPtyOutputIfStale(1_000 + PTY_OUTPUT_PIN_AFTER_MS - 1);
		expect(ptyOutputRecorder.snapshot()[0]!.pinned).toBeNull();
		pinPtyOutputIfStale(1_000 + PTY_OUTPUT_PIN_AFTER_MS);
		expect(ptyOutputRecorder.snapshot()[0]!.pinned?.chunks).toEqual([{ at: 1_000, text: "trigger" }]);
		// A fresh beat ends the episode.
		recordFreezeDiagnostic({ kind: "beat", windowId: 1, beat }, 8_000);
		pinPtyOutputIfStale(8_000);
		expect(ptyOutputRecorder.snapshot()[0]!.pinned).toBeNull();
		// Turning the switch off drops the recorded output with the collector.
		applyFreezeDiagnosticsSetting(false, "darwin");
		expect(ptyOutputRecorder.isEnabled()).toBe(false);
		expect(ptyOutputRecorder.snapshot()).toEqual([]);
	});

	it("writes a private dump named after the capture, newest clients first within a size cap", () => {
		const dir = mkdtempSync(join(tmpdir(), "dev3-freeze-pty-dump-"));
		directories.push(dir);
		ptyOutputRecorder.setEnabled(true);
		ptyOutputRecorder.record({}, "11111111-aaaa-bbbb-cccc-dddddddddddd", "\x1b[31mold\x1b[0m", 1);
		ptyOutputRecorder.record({}, "22222222-aaaa-bbbb-cccc-dddddddddddd", "new", 2);
		expect(writePtyOutput(request, { directory: dir, at: 5 })).toMatchObject({ ok: true, clients: 2 });
		const file = join(dir, "freeze-1-10.2-pty.json");
		expect(statSync(file).mode & 0o777).toBe(0o600);
		const dump = JSON.parse(readFileSync(file, "utf8"));
		expect(dump).toMatchObject({ event: "pty-output", capturedAt: 5, reasons: ["window-1-heartbeat-missing"] });
		expect(dump.clients.map((c: { taskId: string }) => c.taskId)).toEqual(["22222222", "11111111"]);
		expect(dump.clients[1].chunks).toEqual([{ at: 1, text: "\x1b[31mold\x1b[0m" }]);
		// Over the cap, the least recently written clients go first.
		expect(writePtyOutput(request, { directory: dir, maxBytes: 400 })).toMatchObject({ ok: true, clients: 1 });
		expect(JSON.parse(readFileSync(file, "utf8")).clients.map((c: { taskId: string }) => c.taskId)).toEqual(["22222222"]);
	});

	it("refuses a dump name that is not one of the collector's own files", () => {
		const dir = mkdtempSync(join(tmpdir(), "dev3-freeze-pty-name-"));
		directories.push(dir);
		ptyOutputRecorder.setEnabled(true);
		ptyOutputRecorder.record({}, "task", "x");
		expect(writePtyOutput({ ...request, session: "../escape" }, { directory: dir }).ok).toBe(false);
		expect(readdirSync(dir)).toEqual([]);
	});

	it("asks for terminal output only when a renderer stopped beating", () => {
		expect(wantsPtyOutput(["window-1-heartbeat-missing"])).toBe(true);
		expect(wantsPtyOutput(["host-heartbeat-missing", "window-3-heartbeat-missing"])).toBe(true);
		expect(wantsPtyOutput(["window-1-animation-frame-missing"])).toBe(false);
		expect(wantsPtyOutput(["host-heartbeat-missing"])).toBe(false);
	});

	it("answers the worker's request by writing the dump and reporting the result back", async () => {
		const root = mkdtempSync(join(tmpdir(), "dev3-freeze-pty-roundtrip-"));
		directories.push(root);
		logRoot.path = root;
		const workerPath = join(root, "worker.mjs");
		writeFileSync(workerPath, [
			"import { parentPort, workerData } from 'node:worker_threads';",
			"import { mkdirSync, writeFileSync } from 'node:fs';",
			"mkdirSync(workerData.directory, { recursive: true });",
			"parentPort.on('message', (m) => { if (m.kind === 'pty-output') writeFileSync(workerData.directory + '/reply.json', JSON.stringify(m)); });",
			`parentPort.postMessage(${JSON.stringify(request)});`,
		].join("\n"));
		configureFreezeDiagnostics({ workerPath, version: "test", build: "test" });
		applyFreezeDiagnosticsSetting(true, "darwin");
		ptyOutputRecorder.record({}, "33333333-aaaa-bbbb-cccc-dddddddddddd", "stuck here");
		const replyPath = join(freezeDiagnosticsDirectory(), "reply.json");
		await vi.waitFor(() => expect(readdirSync(freezeDiagnosticsDirectory())).toContain("reply.json"), { timeout: 5_000 });
		expect(JSON.parse(readFileSync(replyPath, "utf8"))).toMatchObject({ kind: "pty-output", number: 2, ok: true, clients: 1 });
		const dump = JSON.parse(readFileSync(join(freezeDiagnosticsDirectory(), "freeze-1-10.2-pty.json"), "utf8"));
		expect(dump.clients[0].chunks[0].text).toBe("stuck here");
	});
});
