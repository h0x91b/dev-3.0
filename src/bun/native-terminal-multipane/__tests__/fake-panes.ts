/**
 * In-memory stand-in for the registry so coordinator behaviour is provable
 * without spawning real hosts. Real-process coverage lives in the bun-e2e
 * harness; these fakes only model ownership, liveness, and writer roles.
 */

import type { OwnershipVerdict } from "../../native-terminal-registry/ownership";
import type { NativeSessionRecord } from "../../native-terminal-registry/record";
import type { StartOptions, StartResult } from "../../native-terminal-registry/registry";
import type { ClientRole } from "../../native-terminal-registry/writer-ownership";
import type { CoordinatorDeps, PaneConnection } from "../coordinator";

export interface FakePane {
	record: NativeSessionRecord;
	token: string;
	alive: boolean;
	launch: StartOptions["launch"];
	writerTaken: boolean;
	resizes: Array<{ cols: number; rows: number }>;
	inputs: string[];
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
		ownership: { evidenceKind: "posix-start-signature" },
		cols: opts.cols ?? 80,
		rows: opts.rows ?? 24,
		createdAt: new Date().toISOString(),
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
				capture(_includeHistory) {
					return pane.inputs.join("");
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
