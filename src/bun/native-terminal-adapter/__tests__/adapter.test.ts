/**
 * Native single-view adapter mapping, driven through injected seams (no real
 * host, socket, or WASM). Proves the ParityRunner surface: stable ids, presence,
 * single active view, input write-through, snapshot capture, deferred multi-view,
 * dead-view/missing-session handling, and idempotent-yet-strict cleanup.
 */
import { describe, expect, it, vi } from "vitest";
import type { NativeSessionClient } from "../../native-terminal-registry/client";
import type { OwnershipVerdict } from "../../native-terminal-registry/ownership";
import { NATIVE_SESSION_SCHEMA_VERSION, type NativeSessionRecord } from "../../native-terminal-registry/record";
import type { ParserStateSnapshot } from "../../native-terminal-registry/parser-state";
import {
	PARSER_STATE_SCHEMA,
	PARSER_STATE_VERSION,
} from "../../native-terminal-registry/parser-state";
import { LIVE_PARSER_ID } from "../../native-terminal-registry/ghostty-live";
import { NativeSingleViewAdapter, type NativeAdapterDeps } from "../adapter";
import { MultiViewUnsupportedError, NativeSessionNotFoundError, NativeViewGoneError } from "../errors";

function makeRecord(id: string): NativeSessionRecord {
	return {
		schemaVersion: NATIVE_SESSION_SCHEMA_VERSION,
		sessionId: id,
		paneId: `${id}:0`,
		protocolVersion: 1,
		hostArtifactVersion: "1",
		runtimeVersion: "1.3.14",
		platform: "linux",
		host: { pid: 4242, executable: "/bin/bun", startSignature: "h" },
		shell: { pid: 4243, command: ["/bin/sh"], startSignature: "s" },
		endpoint: { transport: "ws", address: "127.0.0.1", port: 51515 },
		ownership: { evidenceKind: "posix-start-signature" },
		cols: 80,
		rows: 24,
		createdAt: "2026-07-24T00:00:00.000Z",
		updatedAt: "2026-07-24T00:00:00.000Z",
	};
}

function snapshotWith(lines: string[]): ParserStateSnapshot {
	return {
		schema: PARSER_STATE_SCHEMA,
		version: PARSER_STATE_VERSION,
		parser: LIVE_PARSER_ID,
		sessionId: "alpha",
		watermarkSeq: 1,
		health: { status: "live", overflow: { droppedChunks: 0, droppedBytes: 0, droppedResizes: 0 } },
		ingested: { frames: 0, bytes: 0, resizes: 0, replies: 0 },
		latency: { drains: 0, totalMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0 },
		memory: { rssBytes: 0, heapUsedBytes: 0 },
		state: {
			activeBuffer: "normal",
			title: "",
			dimensions: { cols: 80, rows: lines.length },
			cursor: { x: 0, y: 0, visible: true, style: "block", blink: false },
			modes: {
				applicationCursorKeys: false,
				applicationKeypad: false,
				bracketedPaste: false,
				focusEvents: false,
				insert: false,
				mouseTracking: "none",
				origin: false,
				reverseWraparound: false,
				synchronizedOutput: false,
				wraparound: true,
			},
			screen: lines.map((text) => ({ text, wrapped: null, cells: [] })),
			scrollback: [],
			scrollbackLength: 0,
		},
		updatedAt: "2026-07-24T00:00:00.000Z",
	};
}

interface Harness {
	adapter: NativeSingleViewAdapter;
	records: Map<string, NativeSessionRecord>;
	snapshots: Map<string, ParserStateSnapshot>;
	verdict: { value: OwnershipVerdict };
	client: { input: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
	stop: ReturnType<typeof vi.fn>;
	start: ReturnType<typeof vi.fn>;
}

function harness(overrides: Partial<NativeAdapterDeps> = {}): Harness {
	const records = new Map<string, NativeSessionRecord>();
	const snapshots = new Map<string, ParserStateSnapshot>();
	const verdict = { value: "owned" as OwnershipVerdict };
	const client = { input: vi.fn(), close: vi.fn() };
	const start = vi.fn(async (id: string) => {
		const record = makeRecord(id);
		records.set(id, record);
		return { status: "started" as const, record };
	});
	const stop = vi.fn(async (id: string) => {
		const existed = records.delete(id);
		snapshots.delete(id);
		return existed;
	});
	const deps: Partial<NativeAdapterDeps> = {
		start: start as unknown as NativeAdapterDeps["start"],
		stop: stop as unknown as NativeAdapterDeps["stop"],
		readRecord: (id) => records.get(id) ?? null,
		readToken: (id) => (records.has(id) ? `token-${id}` : null),
		classifyOwnership: async () => verdict.value,
		readSnapshot: (id) => snapshots.get(id) ?? null,
		connect: async () => client as unknown as NativeSessionClient,
		...overrides,
	};
	const adapter = new NativeSingleViewAdapter({ owner: true, deps });
	return { adapter, records, snapshots, verdict, client, stop, start };
}

describe("NativeSingleViewAdapter — lifecycle mapping", () => {
	it("creates a session with a live parser and returns the stable first view id", async () => {
		const h = harness();
		const handle = await h.adapter.createSession({ id: "alpha", cwd: "/tmp", command: "sh" });
		expect(handle).toEqual({ id: "alpha", firstViewId: "alpha:0" });
		expect(h.start).toHaveBeenCalledWith(
			"alpha",
			expect.objectContaining({ liveParser: true, cols: 80, rows: 24 }),
			undefined,
		);
		const [, opts] = h.start.mock.calls[0];
		expect(opts.launch).toEqual({ executable: "sh", argv: [], cwd: "/tmp", env: {} });
	});

	it("reports presence, a single active view, and a stable active id", async () => {
		const h = harness();
		await h.adapter.createSession({ id: "alpha", cwd: "/tmp", command: "sh" });
		expect(await h.adapter.isSessionPresent("alpha")).toBe(true);
		expect(await h.adapter.listViews("alpha")).toEqual([{ id: "alpha:0", active: true }]);
		expect(await h.adapter.activeViewId("alpha")).toBe("alpha:0");
	});

	it("treats a missing / not-owned session as absent with an empty view list", async () => {
		const h = harness();
		expect(await h.adapter.isSessionPresent("ghost")).toBe(false);
		expect(await h.adapter.listViews("ghost")).toEqual([]);
		expect(await h.adapter.activeViewId("ghost")).toBeNull();

		await h.adapter.createSession({ id: "alpha", cwd: "/tmp", command: "sh" });
		h.verdict.value = "reused"; // a reused PID is not ours
		expect(await h.adapter.isSessionPresent("alpha")).toBe(false);
		expect(await h.adapter.listViews("alpha")).toEqual([]);
	});

	it("writes input as a PTY submit through an attached client", async () => {
		const h = harness();
		await h.adapter.createSession({ id: "alpha", cwd: "/tmp", command: "sh" });
		await h.adapter.sendInput("alpha", "alpha:0", "echo hi");
		expect(h.client.input).toHaveBeenCalledWith("echo hi\r");
	});

	it("captures the bounded snapshot text, or empty before any output", async () => {
		const h = harness();
		await h.adapter.createSession({ id: "alpha", cwd: "/tmp", command: "sh" });
		expect(await h.adapter.capture("alpha", "alpha:0", { includeHistory: true })).toBe("");
		h.snapshots.set("alpha", snapshotWith(["PARITY-L1", "PARITY-L2"]));
		expect(await h.adapter.capture("alpha", "alpha:0", { includeHistory: true })).toBe("PARITY-L1\nPARITY-L2");
	});
});

describe("NativeSingleViewAdapter — negative + deferred handling", () => {
	it("defers splitView to the multi-view roadmap with a typed error", async () => {
		const h = harness();
		await h.adapter.createSession({ id: "alpha", cwd: "/tmp", command: "sh" });
		await expect(h.adapter.splitView("alpha", "alpha:0", { cwd: "/tmp" })).rejects.toBeInstanceOf(
			MultiViewUnsupportedError,
		);
	});

	it("focuses the sole view but rejects a second-view focus", async () => {
		const h = harness();
		await h.adapter.createSession({ id: "alpha", cwd: "/tmp", command: "sh" });
		await expect(h.adapter.focusView("alpha", "alpha:0")).resolves.toBeUndefined();
		await expect(h.adapter.focusView("alpha", "alpha:1")).rejects.toBeInstanceOf(MultiViewUnsupportedError);
	});

	it("raises typed errors for missing sessions and gone views", async () => {
		const h = harness();
		await expect(h.adapter.sendInput("ghost", "ghost:0", "x")).rejects.toBeInstanceOf(NativeSessionNotFoundError);
		await expect(h.adapter.capture("ghost", "ghost:0")).rejects.toBeInstanceOf(NativeSessionNotFoundError);
		await h.adapter.createSession({ id: "alpha", cwd: "/tmp", command: "sh" });
		await expect(h.adapter.capture("alpha", "alpha:9")).rejects.toBeInstanceOf(NativeViewGoneError);
	});

	it("cleans up an owned session and reaps only its own tree", async () => {
		const h = harness();
		await h.adapter.createSession({ id: "alpha", cwd: "/tmp", command: "sh" });
		await h.adapter.cleanupSession("alpha");
		expect(h.stop).toHaveBeenCalledWith("alpha", {}, undefined);
		expect(await h.adapter.isSessionPresent("alpha")).toBe(false);
		expect(h.client.close).toHaveBeenCalledTimes(0); // no client was attached (no input)
	});

	it("is idempotent best-effort but strict on an already-gone session", async () => {
		const h = harness();
		await h.adapter.createSession({ id: "alpha", cwd: "/tmp", command: "sh" });
		await h.adapter.cleanupSession("alpha"); // strict removal succeeds
		await expect(h.adapter.cleanupSession("alpha", { bestEffort: true })).resolves.toBeUndefined();
		await expect(h.adapter.cleanupSession("alpha")).rejects.toBeInstanceOf(NativeSessionNotFoundError);
	});

	it("closes the attached client on cleanup and killView tears the session down", async () => {
		const h = harness();
		await h.adapter.createSession({ id: "alpha", cwd: "/tmp", command: "sh" });
		await h.adapter.sendInput("alpha", "alpha:0", "echo hi"); // attaches a client
		await h.adapter.killView("alpha", "alpha:0");
		expect(h.client.close).toHaveBeenCalledTimes(1);
		expect(h.stop).toHaveBeenCalledWith("alpha", {}, undefined);
		expect(await h.adapter.isSessionPresent("alpha")).toBe(false);
	});

	it("owner dispose stops every created session; a reconnect owns nothing", async () => {
		const h = harness();
		await h.adapter.createSession({ id: "alpha", cwd: "/tmp", command: "sh" });
		const fresh = h.adapter.reconnect();
		await fresh.dispose();
		expect(h.stop).not.toHaveBeenCalled(); // reconnect is not the owner
		await h.adapter.dispose();
		expect(h.stop).toHaveBeenCalledWith("alpha", {}, undefined);
	});
});
