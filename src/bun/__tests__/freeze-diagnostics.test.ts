import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, statSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFreezeMonitor } from "../freeze-diagnostics/monitor";
import { createCaptureStore, createStackCapture, rendererPids } from "../freeze-diagnostics/capture";
import { freezeDiagnosticsEnabled, freezeBeat } from "../freeze-diagnostics";
import type { FreezeBeat } from "../freeze-diagnostics/protocol";

vi.mock("../logger", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }), getLogPath: () => "/unused" }));
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
	it("is off by default, independent of canary, and macOS only", () => {
		expect(freezeDiagnosticsEnabled({}, "darwin")).toBe(false);
		expect(freezeDiagnosticsEnabled({ DEV3_CHANNEL: "canary" }, "darwin")).toBe(false);
		expect(freezeDiagnosticsEnabled({ DEV3_DEBUG: "1" }, "darwin")).toBe(true);
		expect(freezeDiagnosticsEnabled({ DEV3_DEBUG: "0" }, "darwin")).toBe(false);
		expect(freezeDiagnosticsEnabled({ DEV3_DEBUG: "1" }, "linux")).toBe(false);
		expect(freezeDiagnosticsEnabled({ DEV3_DEBUG: "1" }, "win32")).toBe(false);
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
});
