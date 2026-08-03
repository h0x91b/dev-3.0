/**
 * In-memory stand-in for the registry so coordinator behaviour is provable
 * without spawning real hosts. Real-process coverage lives in the bun-e2e
 * harness; these fakes only model ownership, liveness, and writer roles.
 */

import type { OwnershipVerdict } from "../../native-terminal-registry/ownership";
import {
	CAPTURE_RECORD_SCHEMA,
	CAPTURE_RECORD_VERSION,
	type CaptureRecord,
	type CaptureRecordInspection,
} from "../../native-terminal-registry/capture-record";
import {
	NATIVE_SESSION_CAPTURE_CAPABILITY,
	type NativeSessionRecord,
} from "../../native-terminal-registry/record";
import type { StartOptions, StartResult } from "../../native-terminal-registry/registry";
import type { ClientRole } from "../../native-terminal-registry/writer-ownership";
import type { NativeSemanticLine, NativeSemanticState } from "../../native-terminal-registry/ghostty-live";
import { LIVE_PARSER_ID } from "../../native-terminal-registry/ghostty-live";
import { PARSER_STATE_SCHEMA, PARSER_STATE_VERSION, type ParserStateSnapshot } from "../../native-terminal-registry/parser-state";
import type { CoordinatorDeps, PaneConnection, ParserStateInspection } from "../coordinator";

export interface FakePane {
	record: NativeSessionRecord;
	token: string;
	alive: boolean;
	launch: StartOptions["launch"];
	writerTaken: boolean;
	resizes: Array<{ cols: number; rows: number }>;
	inputs: string[];
	/** How this pane's parser snapshot reads — what a read-only capture sources. */
	parserState: "publishing" | "absent" | "rejected";
	/** Bytes the fake parser claims it dropped, so gap reporting is provable. */
	droppedBytes: number;
}

export interface FakeRegistry extends CoordinatorDeps {
	panes: Map<string, FakePane>;
	startCalls: string[];
	stopCalls: string[];
	kill(sessionId: string): void;
}

let nextPid = 1000;

function fakeRecord(sessionId: string, opts: StartOptions): NativeSessionRecord {
	const hostPid = ++nextPid;
	const shellPid = ++nextPid;
	return {
		schemaVersion: 1,
		sessionId,
		// What a real host writes here: its OWN internal pane label, not the
		// coordinator's logical pane id.
		paneId: `${sessionId}:0`,
		protocolVersion: 1,
		hostArtifactVersion: "1",
		runtimeVersion: "test",
		platform: process.platform,
		host: { pid: hostPid, executable: "bun", startSignature: `host-${hostPid}` },
		shell: {
			pid: shellPid,
			command: [opts.launch.executable, ...opts.launch.argv],
			startSignature: `shell-${shellPid}`,
		},
		endpoint: { transport: "ws", address: "127.0.0.1", port: 40000 + shellPid },
		// A fake host advertises a capture surface by default; a test that wants a
		// parser-less pane clears it, exactly as an older or plain host would.
		capabilities: { capture: [NATIVE_SESSION_CAPTURE_CAPABILITY] },
		ownership: { evidenceKind: "posix-start-signature" },
		cols: opts.cols ?? 80,
		rows: opts.rows ?? 24,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

function semanticLine(text: string): NativeSemanticLine {
	return { text, wrapped: null, cells: [] };
}

/**
 * A parser snapshot over the pane's echoed input: the LAST `rows` lines are the
 * visible screen and everything before them is scrollback, which is exactly the
 * shape a real host publishes.
 */
function fakeParserState(pane: FakePane): ParserStateSnapshot {
	const lines = pane.inputs.join("").split(/\r\n|\r|\n/);
	const rows = pane.record.rows;
	const screen = lines.slice(-rows);
	const scrollback = lines.slice(0, Math.max(0, lines.length - rows));
	const state: NativeSemanticState = {
		activeBuffer: "normal",
		title: "",
		dimensions: { cols: pane.record.cols, rows },
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
		screen: screen.map(semanticLine),
		scrollback: scrollback.map(semanticLine),
		scrollbackLength: scrollback.length,
	};
	return {
		schema: PARSER_STATE_SCHEMA,
		version: PARSER_STATE_VERSION,
		parser: LIVE_PARSER_ID,
		sessionId: pane.record.sessionId,
		watermarkSeq: pane.inputs.length,
		health: {
			status: "live",
			overflow: { droppedChunks: pane.droppedBytes > 0 ? 1 : 0, droppedBytes: pane.droppedBytes, droppedResizes: 0 },
		},
		ingested: { frames: pane.inputs.length, bytes: pane.inputs.join("").length, resizes: pane.resizes.length, replies: 0 },
		latency: { drains: 0, totalMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0 },
		memory: { rssBytes: 0, heapUsedBytes: 0 },
		state,
		updatedAt: new Date().toISOString(),
	};
}

export function createFakeRegistry(): FakeRegistry {
	const panes = new Map<string, FakePane>();
	const startCalls: string[] = [];
	const stopCalls: string[] = [];

	const registry: FakeRegistry = {
		panes,
		startCalls,
		stopCalls,
		kill(sessionId) {
			const pane = panes.get(sessionId);
			if (pane) pane.alive = false;
		},
		async startPane(sessionId, opts): Promise<StartResult> {
			startCalls.push(sessionId);
			const existing = panes.get(sessionId);
			if (existing?.alive) return { status: "already-running", record: existing.record };
			const record = fakeRecord(sessionId, opts);
			panes.set(sessionId, {
				record,
				token: `token-${sessionId}-${record.host.pid}`,
				alive: true,
				launch: opts.launch,
				writerTaken: false,
				resizes: [],
				inputs: [],
				parserState: "publishing",
				droppedBytes: 0,
			});
			return { status: "started", record };
		},
		async stopPane(sessionId): Promise<boolean> {
			stopCalls.push(sessionId);
			panes.delete(sessionId);
			return true;
		},
		readPaneRecord(sessionId): NativeSessionRecord | null {
			const pane = panes.get(sessionId);
			return pane?.alive ? pane.record : null;
		},
		readPaneToken(sessionId): string | null {
			const pane = panes.get(sessionId);
			return pane?.alive ? pane.token : null;
		},
		inspectPaneCaptureRecord(sessionId, _producerDigest): CaptureRecordInspection {
			const pane = panes.get(sessionId);
			if (!pane) return { kind: "absent" };
			if (pane.parserState === "absent") return { kind: "absent" };
			if (pane.parserState === "rejected") return { kind: "rejected", problem: "fake rejection" };
			const snapshot = fakeParserState(pane);
			const state = snapshot.state!;
			const record: CaptureRecord = {
				schema: CAPTURE_RECORD_SCHEMA,
				version: CAPTURE_RECORD_VERSION,
				sessionId,
				producer: {
					hostPid: pane.record.host.pid,
					hostStartSignature: pane.record.host.startSignature,
					shellPid: pane.record.shell.pid,
					shellStartSignature: pane.record.shell.startSignature,
				},
				updatedAt: snapshot.updatedAt,
				watermarkSeq: snapshot.watermarkSeq,
				activeBuffer: state.activeBuffer,
				cols: state.dimensions.cols,
				rows: state.dimensions.rows,
				viewport: state.screen.map((line) => line.text),
				history: state.scrollback.map((line) => line.text),
				historyTotal: state.scrollbackLength,
				viewportRowsOmitted: 0,
				health: {
					status: snapshot.health.status,
					droppedBytes: snapshot.health.overflow.droppedBytes,
					droppedChunks: snapshot.health.overflow.droppedChunks,
					resyncGaps: 0,
				},
			};
			return { kind: "present", record };
		},
		inspectPaneParserState(sessionId): ParserStateInspection {
			const pane = panes.get(sessionId);
			if (!pane || pane.parserState === "absent") return { kind: "absent" };
			if (pane.parserState === "rejected") return { kind: "rejected", problem: "fake rejection" };
			return { kind: "present", snapshot: fakeParserState(pane) };
		},
		async classifyPane(record, token): Promise<OwnershipVerdict> {
			const pane = panes.get(record.sessionId);
			if (!pane || !pane.alive) return "dead";
			return pane.token === token ? "owned" : "reused";
		},
		async connectPane(record): Promise<PaneConnection> {
			const pane = panes.get(record.sessionId);
			if (!pane || !pane.alive) throw new Error(`no fake pane ${record.sessionId}`);
			// Mirror the host rule: the first live attachment is writer, the rest observe.
			const role: ClientRole = pane.writerTaken ? "observer" : "writer";
			pane.writerTaken = true;
			let closed = false;
			return {
				role: () => role,
				onOutput: () => () => undefined,
				input(data) {
					pane.inputs.push(typeof data === "string" ? data : new TextDecoder().decode(data));
				},
				resize(cols, rows) {
					pane.resizes.push({ cols, rows });
					pane.record.cols = cols;
					pane.record.rows = rows;
				},
				close() {
					if (closed) return;
					closed = true;
					if (role === "writer") pane.writerTaken = false;
				},
			};
		},
	};
	return registry;
}
