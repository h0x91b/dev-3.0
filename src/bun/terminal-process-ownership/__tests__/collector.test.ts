import { describe, expect, it, vi } from "vitest";
import {
	buildOwnershipSnapshot,
	collectOwnershipSnapshot,
	type TerminalOwnershipEvidence,
	type TerminalOwnershipScanners,
} from "../collector";
import { nativeOwnershipClaim } from "../native-source";
import { verifiedClaim } from "../contract";
import { tmuxOwnershipClaimFromPanePids } from "../tmux-source";

/** shell 4101 → nested child 4200 → grandchild 4300 (the listener). */
const tree = new Map<number, number[]>([
	[4100, [4101]],
	[4101, [4200]],
	[4200, [4300]],
	// An unrelated process tree that must never be attributed.
	[9000, [9001]],
]);

const resources = new Map<number, { rss: number; cpu: number }>([
	[4100, { rss: 1_000, cpu: 1 }],
	[4101, { rss: 2_000, cpu: 2 }],
	[4200, { rss: 4_000, cpu: 4 }],
	[4300, { rss: 8_000, cpu: 8 }],
	[9001, { rss: 999_000, cpu: 99 }],
]);

/** `lsof -F pcn`: the owned grandchild plus an unrelated sentinel listener. */
const lsofOutput = ["p4300", "cbun", "n127.0.0.1:4321", "p9001", "csentinel", "n*:5999", ""].join("\n");

const evidence: TerminalOwnershipEvidence = { tree, resources, lsofOutput };

const ownedNative = nativeOwnershipClaim({
	sessionId: "sess-1",
	record: { sessionId: "sess-1", host: { pid: 4100 }, shell: { pid: 4101 } },
	verdict: "owned",
});

const throwingScanners: TerminalOwnershipScanners = {
	processInfo: async () => {
		throw new Error("processInfo must not run for an unproved claim");
	},
	lsof: async () => {
		throw new Error("lsof must not run for an unproved claim");
	},
};

describe("ownership snapshot", () => {
	it("attributes nested descendants and their listening ports", () => {
		const snapshot = buildOwnershipSnapshot(ownedNative, evidence);
		expect(snapshot.backend).toBe("native");
		expect(snapshot.sessionId).toBe("sess-1");
		if (snapshot.ownership.state !== "owned") throw new Error("expected owned ownership");
		expect(snapshot.ownership.processes).toEqual([
			{ pid: 4100, role: "host" },
			{ pid: 4101, role: "shell" },
			{ pid: 4200, role: "descendant" },
			{ pid: 4300, role: "descendant" },
		]);
		expect(snapshot.ports).toEqual([{ port: 4321, pid: 4300, processName: "bun" }]);
		expect(snapshot.resources).toEqual({ rss: 15_000, cpu: 15 });
		expect(snapshot.coverage).toEqual({ descendants: true, resources: true, ports: true });
	});

	it("never attributes an unrelated process, its cost, or its port", () => {
		const snapshot = buildOwnershipSnapshot(ownedNative, evidence);
		if (snapshot.ownership.state !== "owned") throw new Error("expected owned ownership");
		const pids = snapshot.ownership.processes.map((process) => process.pid);
		expect(pids).not.toContain(9000);
		expect(pids).not.toContain(9001);
		expect(snapshot.ports.map((port) => port.port)).not.toContain(5999);
		expect(snapshot.resources?.rss).toBeLessThan(999_000);
	});

	it("counts nothing for an exited (stale) session", () => {
		const claim = nativeOwnershipClaim({
			sessionId: "sess-1",
			record: { sessionId: "sess-1", host: { pid: 4100 }, shell: { pid: 4101 } },
			verdict: "dead",
		});
		const snapshot = buildOwnershipSnapshot(claim, evidence);
		expect(snapshot.ownership).toEqual({
			state: "stale",
			reason: "the recorded native host or shell process has exited",
		});
		expect(snapshot.resources).toBeNull();
		expect(snapshot.ports).toEqual([]);
		expect(snapshot.coverage).toEqual({ descendants: false, resources: false, ports: false });
	});

	it("counts nothing for a reused PID even though the PID is alive and busy", () => {
		const claim = nativeOwnershipClaim({
			sessionId: "sess-1",
			// 9001 is alive in the evidence and holds a port — but it is not ours.
			record: { sessionId: "sess-1", host: { pid: 9000 }, shell: { pid: 9001 } },
			verdict: "reused",
		});
		const snapshot = buildOwnershipSnapshot(claim, evidence);
		expect(snapshot.ownership).toMatchObject({ state: "reused" });
		expect(snapshot.resources).toBeNull();
		expect(snapshot.ports).toEqual([]);
	});

	it("reports absent scanners as unmeasured coverage, not as an empty result", () => {
		const snapshot = buildOwnershipSnapshot(ownedNative, { tree: null, resources: null, lsofOutput: null });
		if (snapshot.ownership.state !== "owned") throw new Error("expected owned ownership");
		expect(snapshot.ownership.processes.map((process) => process.pid)).toEqual([4100, 4101]);
		expect(snapshot.resources).toBeNull();
		expect(snapshot.ports).toEqual([]);
		expect(snapshot.coverage).toEqual({ descendants: false, resources: false, ports: false });
	});

	it("keeps tmux pane roots and their descendants distinct per role", () => {
		const snapshot = buildOwnershipSnapshot(tmuxOwnershipClaimFromPanePids("dev3-task-abc", [4101]), evidence);
		if (snapshot.ownership.state !== "owned") throw new Error("expected owned ownership");
		expect(snapshot.backend).toBe("tmux");
		expect(snapshot.ownership.processes).toEqual([
			{ pid: 4101, role: "pane" },
			{ pid: 4200, role: "descendant" },
			{ pid: 4300, role: "descendant" },
		]);
	});

	it("does not list a shared PID twice when roots overlap", () => {
		const snapshot = buildOwnershipSnapshot(verifiedClaim("tmux", "dev3-task-abc", [
			{ pid: 4101, role: "pane" },
			{ pid: 4200, role: "pane" },
		]), evidence);
		if (snapshot.ownership.state !== "owned") throw new Error("expected owned ownership");
		expect(snapshot.ownership.processes.map((process) => process.pid)).toEqual([4101, 4200, 4300]);
	});
});

describe("collectOwnershipSnapshot", () => {
	it("runs no scanner at all for an unproved claim", async () => {
		const claim = nativeOwnershipClaim({ sessionId: "sess-1", record: null });
		const snapshot = await collectOwnershipSnapshot(claim, throwingScanners);
		expect(snapshot.ownership).toMatchObject({ state: "unavailable" });
		expect(snapshot.coverage).toEqual({ descendants: false, resources: false, ports: false });
	});

	it("pulls evidence from the injected scanners exactly once for a proved claim", async () => {
		const processInfo = vi.fn(async () => ({ tree, resources }));
		const lsof = vi.fn(async () => lsofOutput);
		const snapshot = await collectOwnershipSnapshot(ownedNative, { processInfo, lsof });
		expect(processInfo).toHaveBeenCalledTimes(1);
		expect(lsof).toHaveBeenCalledTimes(1);
		expect(snapshot.ports).toEqual([{ port: 4321, pid: 4300, processName: "bun" }]);
	});

	it("survives scanners that report nothing measurable", async () => {
		const snapshot = await collectOwnershipSnapshot(ownedNative, {
			processInfo: async () => null,
			lsof: async () => null,
		});
		expect(snapshot.coverage).toEqual({ descendants: false, resources: false, ports: false });
		expect(snapshot.ownership).toMatchObject({ state: "owned" });
	});
});
