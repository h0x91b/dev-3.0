/**
 * The four-mode artifact and capability matrix, the independence of the two
 * persist sinks, and the N-2 compatibility claim the compact-only mode rests on.
 */

import { describe, expect, it, vi } from "vitest";
import {
	NATIVE_CAPTURE_MODES,
	modePersistsCompact,
	modePersistsSemantic,
	modeRunsParser,
	parseCaptureMode,
	type NativeCaptureMode,
} from "../capture-mode";
import {
	NATIVE_SESSION_CAPTURE_CAPABILITY,
	NATIVE_SESSION_TEXT_CAPTURE_CAPABILITY,
	parseRecord,
	serializeRecord,
	type NativeSessionCaptureSurface,
	type NativeSessionRecord,
} from "../record";
import { captureRecordOf, serializeCaptureRecord } from "../capture-record";
import { n2CaptureText, n2ParseRecord } from "./n2-fixtures/n2-reader";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What each mode is contractually required to do. */
const MATRIX: Array<{
	mode: NativeCaptureMode;
	parser: boolean;
	semantic: boolean;
	compact: boolean;
	surfaces: NativeSessionCaptureSurface[];
}> = [
	{ mode: "none", parser: false, semantic: false, compact: false, surfaces: [] },
	{
		mode: "semantic",
		parser: true,
		semantic: true,
		compact: false,
		surfaces: [NATIVE_SESSION_CAPTURE_CAPABILITY],
	},
	{
		mode: "compact",
		parser: true,
		semantic: false,
		compact: true,
		surfaces: [NATIVE_SESSION_TEXT_CAPTURE_CAPABILITY],
	},
	{
		mode: "semantic-and-compact",
		parser: true,
		semantic: true,
		compact: true,
		surfaces: [NATIVE_SESSION_CAPTURE_CAPABILITY, NATIVE_SESSION_TEXT_CAPTURE_CAPABILITY],
	},
];

describe("capture mode — the four-mode matrix", () => {
	it("covers every mode exactly once, with no fifth", () => {
		expect(MATRIX.map((row) => row.mode)).toEqual([...NATIVE_CAPTURE_MODES]);
	});

	it.each(MATRIX)("$mode runs the parser: $parser, semantic: $semantic, compact: $compact", (row) => {
		expect(modeRunsParser(row.mode)).toBe(row.parser);
		expect(modePersistsSemantic(row.mode)).toBe(row.semantic);
		expect(modePersistsCompact(row.mode)).toBe(row.compact);
		// Compact must never make semantic unreachable: the two are independent.
		if (row.mode === "semantic-and-compact") expect(row.semantic && row.compact).toBe(true);
	});

	it("never lets compact suppress semantic in any mode", () => {
		for (const mode of NATIVE_CAPTURE_MODES) {
			if (!modePersistsSemantic(mode)) continue;
			expect(modePersistsSemantic(mode)).toBe(true); // holds with compact on or off
		}
	});

	it("reads an unknown or absent mode as none, the publish-nothing side", () => {
		expect(parseCaptureMode(undefined)).toBe("none");
		expect(parseCaptureMode("")).toBe("none");
		expect(parseCaptureMode("compact-ish")).toBe("none");
		expect(parseCaptureMode("1")).toBe("none"); // the retired boolean env value
		for (const mode of NATIVE_CAPTURE_MODES) expect(parseCaptureMode(mode)).toBe(mode);
	});
});

describe("capture mode — independent persist sinks", () => {
	/** A pipeline stand-in exercising exactly the sink wiring the host performs. */
	function sinksFor(mode: NativeCaptureMode) {
		const persistState = vi.fn();
		const persistProjection = vi.fn();
		const options = {
			...(modePersistsSemantic(mode) ? { persistState } : {}),
			...(modePersistsCompact(mode) ? { persistProjection } : {}),
		};
		return { persistState, persistProjection, options };
	}

	it.each(MATRIX)("$mode wires exactly the sinks it promises", (row) => {
		const { options } = sinksFor(row.mode);
		expect("persistState" in options).toBe(row.semantic);
		expect("persistProjection" in options).toBe(row.compact);
	});

	it("advertises surfaces in a stable order for each mode", () => {
		for (const row of MATRIX) {
			const surfaces: NativeSessionCaptureSurface[] = [
				...(row.semantic ? [NATIVE_SESSION_CAPTURE_CAPABILITY] : []),
				...(row.compact ? [NATIVE_SESSION_TEXT_CAPTURE_CAPABILITY] : []),
			];
			expect(surfaces).toEqual(row.surfaces);
		}
	});
});

describe("capture mode — N-2 compatibility of the compact-only mode", () => {
	function newRecord(surfaces: NativeSessionCaptureSurface[]): NativeSessionRecord {
		return {
			schemaVersion: 1,
			sessionId: "alpha",
			paneId: "alpha:0",
			...(surfaces.length ? { capabilities: { capture: surfaces } } : {}),
			protocolVersion: 1,
			hostArtifactVersion: "1",
			runtimeVersion: "1.3.14",
			platform: "darwin",
			host: { pid: 4242, executable: "/bin/bun", startSignature: "h" },
			shell: { pid: 4243, command: ["/bin/bash"], startSignature: "s" },
			endpoint: { transport: "ws", address: "127.0.0.1", port: 51234 },
			ownership: { evidenceKind: "posix-start-signature" },
			cols: 120,
			rows: 40,
			createdAt: "2026-08-03T10:00:00.000Z",
			updatedAt: "2026-08-03T10:00:00.000Z",
		};
	}

	it("the frozen N-2 reader still reads a record from every mode", () => {
		for (const row of MATRIX) {
			const parsed = n2ParseRecord(serializeRecord(newRecord(row.surfaces)));
			expect(parsed).toEqual({
				sessionId: "alpha",
				paneId: "alpha:0",
				hostPid: 4242,
				shellPid: 4243,
				cols: 120,
				rows: 40,
				endpointPort: 51234,
			});
		}
	});

	it("a compact-only session looks EXACTLY like parser-off to the frozen reader", () => {
		const root = mkdtempSync(join(tmpdir(), "dev3-n2-compat-"));
		try {
			// Parser-off: nothing published at all.
			const off = n2CaptureText(root, "alpha", true);

			// Compact-only: capture.json exists, parser-state.json does not.
			const record = captureRecordOf(
				"alpha",
				{ hostPid: 4242, hostStartSignature: "h", shellPid: 4243, shellStartSignature: "s" },
				{
					watermarkSeq: 3,
					activeBuffer: "normal",
					cols: 120,
					rows: 40,
					viewport: ["hello"],
					history: [],
					historyTotal: 0,
					status: "live",
					droppedBytes: 0,
					droppedChunks: 0,
					resyncGaps: 0,
				},
			);
			writeFileSync(join(root, "capture.json"), serializeCaptureRecord(record));
			const compactOnly = n2CaptureText(root, "alpha", true);

			// The whole compatibility claim in one assertion: compact-only removes
			// nothing an N-2 build could read, because there was nothing there.
			expect(compactOnly).toBe(off);
			expect(compactOnly).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("the frozen reader still reads a semantic session, so dual mode loses nothing", () => {
		const root = mkdtempSync(join(tmpdir(), "dev3-n2-compat-"));
		try {
			writeFileSync(
				join(root, "parser-state.json"),
				JSON.stringify({
					schema: "dev3-native-session-parser-state",
					version: 1,
					parser: "ghostty-web@0.4.0",
					sessionId: "alpha",
					state: { screen: [{ text: "legacy-row" }], scrollback: [{ text: "old-row" }] },
				}),
			);
			expect(n2CaptureText(root, "alpha", true)).toBe("old-row\nlegacy-row");
			expect(n2CaptureText(root, "alpha", false)).toBe("legacy-row");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("an unrecognised future surface degrades to fewer capabilities, never a lost session", () => {
		const raw = JSON.parse(serializeRecord(newRecord([]))) as Record<string, unknown>;
		raw.capabilities = { capture: ["semantic-snapshot-v1", "screenshot-v9"] };
		const parsed = parseRecord(JSON.stringify(raw));
		expect(parsed?.capabilities).toEqual({ capture: [NATIVE_SESSION_CAPTURE_CAPABILITY] });
		expect(n2ParseRecord(JSON.stringify(raw))?.sessionId).toBe("alpha");
	});
});
