import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("../spawn", () => ({ spawn: vi.fn() }));

import { readFile } from "node:fs/promises";
import { spawn } from "../spawn";
import { isSameAgentProcess, readAgentProcessSignature } from "../agent-process-signature";

/** One machine: live pids with their start tick, a boot id, and the boot time `ps lstart` adds to the tick. */
let ticks: Map<number, number>;
let bootId: string;
let bootTimeSec: number;

function statLine(pid: number, tick: number): string {
	// A command name with spaces and a ")" is legal; the fields after it are what count.
	const after = ["S", "1", pid, pid, "0", "-1", "4194560", "0", "0", "0", "0", "1", "2", "0", "0", "20", "0", "8", "0", tick, "1000"];
	return `${pid} (tmux: client) x) ${after.join(" ")}\n`;
}

function lstart(tick: number): string {
	return new Date((bootTimeSec + tick / 100) * 1000).toUTCString();
}

function onPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: platform });
}

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
	vi.clearAllMocks();
	ticks = new Map([[4242, 4652300]]);
	bootId = "0f1e2d3c-aaaa-bbbb-cccc-1234567890ab";
	bootTimeSec = 1_793_107_310;
	vi.mocked(readFile).mockImplementation((async (path: string) => {
		if (path === "/proc/sys/kernel/random/boot_id") return `${bootId}\n`;
		const pid = Number(/^\/proc\/(\d+)\/stat$/.exec(path)?.[1]);
		const tick = ticks.get(pid);
		if (tick === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		return statLine(pid, tick);
	}) as never);
	vi.mocked(spawn).mockImplementation(((cmd: string[]) => {
		const tick = ticks.get(Number(cmd[2]));
		const out = tick === undefined ? "" : `${lstart(tick)}\n`;
		return { stdout: new Response(out).body, exited: Promise.resolve(out ? 0 : 1) };
	}) as never);
});

afterEach(() => {
	Object.defineProperty(process, "platform", realPlatform);
});

describe("readAgentProcessSignature / isSameAgentProcess", () => {
	it("Linux: reads the boot id and start tick, past a command name holding spaces and parentheses", async () => {
		onPlatform("linux");
		expect(await readAgentProcessSignature(4242)).toBe(`4242@linux:${bootId}:4652300`);
	});

	it("Linux: the same process still matches after a wall-clock step moves the boot time `ps lstart` uses", async () => {
		onPlatform("linux");
		const signature = await readAgentProcessSignature(4242);
		const before = vi.mocked(spawn).mock.calls.length;
		bootTimeSec += 47;
		expect(await isSameAgentProcess(signature)).toBe(true);
		expect(vi.mocked(spawn).mock.calls.length).toBe(before);
	});

	it("an lstart signature does not survive that step, which is why Linux no longer uses it", async () => {
		onPlatform("darwin");
		const signature = await readAgentProcessSignature(4242);
		expect(signature).toBe(`4242@${lstart(4652300)}`);
		bootTimeSec += 47;
		expect(await isSameAgentProcess(signature)).toBe(false);
	});

	it("Linux: a recycled pid, another boot, or a gone process never matches", async () => {
		onPlatform("linux");
		const signature = await readAgentProcessSignature(4242);
		ticks.set(4242, 9_000_000);
		expect(await isSameAgentProcess(signature)).toBe(false);
		ticks.set(4242, 4652300);
		bootId = "11111111-2222-3333-4444-555555555555";
		expect(await isSameAgentProcess(signature)).toBe(false);
		ticks.delete(4242);
		expect(await readAgentProcessSignature(4242)).toBe("");
		expect(await isSameAgentProcess(signature)).toBe(false);
	});

	it("Linux: a signature stored by an older build in the lstart form is still read back that way", async () => {
		onPlatform("linux");
		expect(await isSameAgentProcess(`4242@${lstart(4652300)}`)).toBe(true);
		expect(await isSameAgentProcess(`4242@${lstart(4652300 + 100)}`)).toBe(false);
	});

	it("rejects a malformed signature or pid without reading anything", async () => {
		onPlatform("linux");
		expect(await isSameAgentProcess("x@linux:b:1")).toBe(false);
		expect(await readAgentProcessSignature(0)).toBe("");
		expect(readFile).not.toHaveBeenCalled();
	});
});
