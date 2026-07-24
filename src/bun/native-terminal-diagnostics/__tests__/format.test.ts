import { describe, expect, it } from "vitest";
import {
	buildDiagnosticsSnapshot,
	formatDiagnosticsSnapshot,
	type DiagnosticsLiveInput,
	type DiagnosticsRecordInput,
	type NativeTerminalDiagnosticsInput,
} from "../index";

const NOW = "2026-07-24T12:00:00.000Z";

/** Registry-record-shaped, carrying the secret fields the formatter must not print. */
interface RecordWithSecrets extends DiagnosticsRecordInput {
	host?: { pid?: number; executable?: string; startSignature?: string };
	shell?: { pid?: number; command?: string[]; startSignature?: string };
	endpoint?: { transport: string; address: string; port: number };
	ownership?: { evidenceKind: string };
	cols?: number;
	rows?: number;
}

/** Parse the formatter output into { header, rows: { label: value } }. */
function parse(text: string): { header: string; rows: Record<string, string> } {
	const [header, ...body] = text.split("\n");
	const rows: Record<string, string> = {};
	for (const line of body) {
		const match = line.match(/^(\S+)\s{2,}(.*)$/);
		if (match) rows[match[1]] = match[2];
	}
	return { header, rows };
}

function healthyInput(): NativeTerminalDiagnosticsInput {
	const record: RecordWithSecrets = {
		sessionId: "alpha",
		paneId: "alpha:0",
		protocolVersion: 1,
		hostArtifactVersion: "1",
		runtimeVersion: "1.3.14",
		platform: "darwin",
		host: { pid: 4242, executable: "/secret/bun", startSignature: "SIGNATURE-SECRET" },
		shell: { pid: 4243, command: ["/bin/bash", "-lc", "SECRET_COMMAND"], startSignature: "SIGNATURE-SECRET" },
		endpoint: { transport: "ws", address: "127.0.0.1", port: 51234 },
		ownership: { evidenceKind: "posix-start-signature" },
		cols: 80,
		rows: 24,
		createdAt: "2026-07-24T11:00:00.000Z",
		updatedAt: "2026-07-24T11:59:59.000Z",
	};
	const live: DiagnosticsLiveInput = {
		sessionId: "alpha",
		paneId: "alpha:0",
		hostPid: 4242,
		shellPid: 4243,
		alive: true,
		startedAt: "2026-07-24T11:00:05.000Z",
		clientRole: "writer",
		writerAttached: true,
	};
	return {
		now: NOW,
		record,
		live,
		verdict: "owned",
		lastAttachAt: "2026-07-24T11:59:58.000Z",
		queue: { pendingBytes: 128, pendingEvents: 3, lastSeq: 42, droppedChunks: 0, droppedBytes: 0, droppedResizes: 0 },
		snapshot: { updatedAt: "2026-07-24T11:59:59.500Z", watermarkSeq: 42, health: "live", frames: 100, bytes: 4096, resizes: 2, replies: 5 },
	};
}

describe("formatDiagnosticsSnapshot", () => {
	it("renders a healthy snapshot as a compact labelled report", () => {
		const { header, rows } = parse(formatDiagnosticsSnapshot(buildDiagnosticsSnapshot(healthyInput())));
		expect(header).toBe(`native-terminal diagnostics v1 @ ${NOW}`);
		expect(rows.session).toBe("alpha");
		expect(rows.view).toBe("alpha:0");
		expect(rows.lifecycle).toBe("running");
		expect(rows.freshness).toBe("age=500ms fresh");
		expect(rows.protocol).toBe("v1");
		expect(rows["host-pid"]).toBe("4242");
		expect(rows["shell-pid"]).toBe("4243");
		expect(rows.writer).toBe("attached (writer)");
		expect(rows["last-attach"]).toBe("2026-07-24T11:59:58.000Z");
		expect(rows.queue).toBe("pending=128B/3ev lastSeq=42 dropped=0c/0B/0r");
		expect(rows.parser).toBe("health=live watermark=42 frames=100 bytes=4096 resizes=2 replies=5 age=500ms");
	});

	it("renders unavailable facts as 'unknown'", () => {
		const { rows } = parse(formatDiagnosticsSnapshot(buildDiagnosticsSnapshot({ now: NOW })));
		expect(rows.session).toBe("unknown");
		expect(rows.lifecycle).toBe("unknown");
		expect(rows.writer).toBe("unknown (unknown)");
		expect(rows.queue).toBe("unknown");
		expect(rows.parser).toBe("unknown");
	});

	it("flags queue overflow and stale freshness", () => {
		const input = healthyInput();
		const { rows } = parse(
			formatDiagnosticsSnapshot(
				buildDiagnosticsSnapshot({
					...input,
					queue: { pendingBytes: 0, pendingEvents: 0, lastSeq: 9, droppedChunks: 2, droppedBytes: 4096, droppedResizes: 1 },
					snapshot: { ...input.snapshot!, updatedAt: "2026-07-24T11:58:00.000Z" },
				}),
			),
		);
		expect(rows.queue).toContain("OVERFLOWED");
		expect(rows.freshness).toBe("age=120000ms stale");
	});

	it("is deterministic and leaks no redacted values", () => {
		const snap = buildDiagnosticsSnapshot(healthyInput());
		expect(formatDiagnosticsSnapshot(snap)).toBe(formatDiagnosticsSnapshot(snap));
		const text = formatDiagnosticsSnapshot(snap);
		for (const secret of ["SECRET_COMMAND", "SIGNATURE-SECRET", "/secret/bun", "/bin/bash", "127.0.0.1", "51234"]) {
			expect(text).not.toContain(secret);
		}
	});
});
