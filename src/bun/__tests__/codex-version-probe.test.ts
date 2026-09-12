import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { detectCodexVersion, resetCodexVersionProbe, detectCodexProfileLaunchFlag, detectCodexHookTrustBypass, resetCodexHelpProbe } from "../codex-config";

beforeEach(() => { resetCodexVersionProbe(); resetCodexHelpProbe(); });

afterEach(() => vi.restoreAllMocks());

it("keeps the event loop responsive and kills a version probe that never exits", async () => {
	const kill = vi.fn();
	vi.spyOn(Bun, "spawn").mockReturnValue({
		pid: 0,
		kill,
		exited: new Promise(() => {}),
		stdout: new ReadableStream(),
		stderr: new ReadableStream(),
	} as never);
	const pending = detectCodexVersion();
	expect(pending).toBeInstanceOf(Promise);
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(kill).not.toHaveBeenCalled();
	expect(await pending).toBeNull();
	expect(kill).toHaveBeenCalledWith(9);
});

it("drains both output streams while waiting for exit", async () => {
	vi.spyOn(Bun, "spawn").mockReturnValue({
		pid: 0,
		kill: vi.fn(),
		exited: Promise.resolve(0),
		stdout: new Response("codex-cli 0.154.0\n").body,
		stderr: new Response("diagnostic\n").body,
	} as never);
	expect(await detectCodexVersion()).toBe("codex-cli 0.154.0");
});

it("shares one pending probe across concurrent callers", async () => {
	const probe = vi.spyOn(Bun, "spawn").mockReturnValue({
		pid: 0, kill: vi.fn(), exited: Promise.resolve(0),
		stdout: new Response("codex-cli 0.154.0").body,
		stderr: new Response("").body,
	} as never);
	const first = detectCodexVersion();
	expect(detectCodexVersion()).toBe(first);
	await first;
	expect(await detectCodexVersion()).toBe("codex-cli 0.154.0");
	expect(probe).toHaveBeenCalledTimes(1);
});

it("returns unknown when the binary is missing", async () => {
	vi.spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("ENOENT"); });
	expect(await detectCodexVersion()).toBeNull();
});

it("ignores version output from an unsuccessful process", async () => {
	vi.spyOn(Bun, "spawn").mockReturnValue({
		pid: 0, kill: vi.fn(), exited: Promise.resolve(1),
		stdout: new Response("codex-cli 0.154.0").body,
		stderr: new Response("failed").body,
	} as never);
	expect(await detectCodexVersion()).toBeNull();
});


it("shares one bounded help probe for profile and hook capabilities", async () => {
	const kill = vi.fn();
	const probe = vi.spyOn(Bun, "spawn").mockReturnValue({
		pid: 0, kill, exited: new Promise(() => {}),
		stdout: new ReadableStream(), stderr: new ReadableStream(),
	} as never);
	const profile = detectCodexProfileLaunchFlag();
	const hooks = detectCodexHookTrustBypass();
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(kill).not.toHaveBeenCalled();
	expect(await profile).toBe("--profile");
	expect(await hooks).toBe(false);
	expect(probe).toHaveBeenCalledTimes(1);
	expect(kill).toHaveBeenCalledWith(9);
});

it("detects both capabilities from help", async () => {
	vi.spyOn(Bun, "spawn").mockReturnValue({
		pid: 0, kill: vi.fn(), exited: Promise.resolve(0),
		stdout: new Response("--profile-v2 --dangerously-bypass-hook-trust").body,
		stderr: new Response("").body,
	} as never);
	expect(await detectCodexProfileLaunchFlag()).toBe("--profile-v2");
	expect(await detectCodexHookTrustBypass()).toBe(true);
});

it("bounds pipe collection even after the child exits", async () => {
	const cancel = vi.fn();
	const kill = vi.fn();
	vi.spyOn(Bun, "spawn").mockReturnValue({
		pid: 0, kill, exited: Promise.resolve(0),
		stdout: new ReadableStream({ cancel }), stderr: new Response("").body,
	} as never);
	expect(await detectCodexVersion()).toBeNull();
	expect(cancel).toHaveBeenCalled();
});
