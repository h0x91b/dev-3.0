import { describe, expect, it } from "vitest";
import { scanSensitive, sanitizeJournal } from "../sanitize-journal";
import type { RawSessionJournal } from "../session-journal";

function journalFrom(
	target: string,
	kind: "shell" | "agent",
	output: string,
): RawSessionJournal {
	return {
		schema: "dev3-windows-session-journal",
		version: 1,
		target,
		kind,
		initial: { cols: 80, rows: 24, scrollback: 1000 },
		finalDimensions: { cols: 80, rows: 24 },
		detachIndex: 1,
		events: [
			{ type: "output", encoding: "base64", data: Buffer.from(output, "utf8").toString("base64") },
		],
		responderReplies: 0,
		queryCounts: { DA1: 1 },
		provenance: {
			command: `${target} probe`,
			platform: "Windows 10.0.19045 x86_64; Bun 1.3.14",
			capturedAt: "2026-07-22",
			exitCode: 0,
		},
	};
}

describe("scanSensitive", () => {
	it("detects secrets, paths, and PII categories without emitting values", () => {
		expect(scanSensitive("token sk-ABCDEFGHIJKLMNOPQRST here")).toContain("openai-key");
		expect(scanSensitive("C:\\Users\\arseny\\project")).toContain("windows-user-path");
		expect(scanSensitive("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456")).toContain("github-token");
		expect(scanSensitive("reach me at dev@example.com")).toContain("email");
		expect(scanSensitive("plain deterministic banner text")).toEqual([]);
	});
});

describe("sanitizeJournal", () => {
	it("keeps a clean shell capture as a fixture and computes metrics", () => {
		const result = sanitizeJournal(journalFrom("cmd", "shell", "cmd banner 1.0 deterministic"));
		expect(result.mode).toBe("fixture");
		expect(result.metrics.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(result.metrics.outputByteLength).toBeGreaterThan(0);
		expect(result.warnings).toEqual([]);
	});

	it("downgrades a shell capture with sensitive output to metrics-only", () => {
		const result = sanitizeJournal(journalFrom("pwsh7", "shell", "leaked C:\\Users\\arseny\\secret"));
		expect(result.mode).toBe("metrics");
		expect(result.metrics.sensitiveCategories).toContain("windows-user-path");
		expect(result.warnings.length).toBeGreaterThan(0);
	});

	it("never stores raw bytes for agent captures", () => {
		const result = sanitizeJournal(journalFrom("claude", "agent", "some agent chrome text"));
		expect(result.mode).toBe("metrics");
		expect(JSON.stringify(result)).not.toContain("some agent chrome text");
		expect(result.metrics.kind).toBe("agent");
		expect(result.metrics.queryCounts).toEqual({ DA1: 1 });
	});
});
