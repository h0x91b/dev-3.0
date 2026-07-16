import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findLatestCodexRollout, readClaudeSnapshot, readCodexSnapshot } from "../rate-limit-monitor";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "dev3-rl-test-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("readClaudeSnapshot", () => {
	it("parses a dump written by `dev3 statusline`", () => {
		const dump = join(tmp, "claude.json");
		writeFileSync(
			dump,
			JSON.stringify({
				capturedAt: 1_783_200_000_000,
				payload: { rate_limits: { five_hour: { used_percentage: 12, resets_at: 1_783_246_800 } } },
			}),
		);
		const snap = readClaudeSnapshot(dump);
		expect(snap!.capturedAt).toBe(1_783_200_000_000);
		expect(snap!.activeAt).toBe(1_783_200_000_000);
		expect(snap!.windows[0].usedPercent).toBe(12);
	});

	it("keeps managed-account attribution from the dump or explicit path context", () => {
		const dump = join(tmp, "claude.json");
		writeFileSync(
			dump,
			JSON.stringify({
				capturedAt: 1_783_200_000_000,
				accountId: "claude-account",
				payload: { rate_limits: { five_hour: { used_percentage: 12 } } },
			}),
		);
		expect(readClaudeSnapshot(dump)?.accountId).toBe("claude-account");
		expect(readClaudeSnapshot(dump, "explicit-account")?.accountId).toBe("explicit-account");
	});

	it("returns null for a missing file", () => {
		expect(readClaudeSnapshot(join(tmp, "nope.json"))).toBeNull();
	});

	it("returns null for a torn/corrupt dump", () => {
		const dump = join(tmp, "claude.json");
		writeFileSync(dump, '{"capturedAt": 123, "payload": {"rate_li');
		expect(readClaudeSnapshot(dump)).toBeNull();
	});
});

describe("findLatestCodexRollout", () => {
	function writeRollout(day: string, name: string, mtimeSec: number): string {
		const dir = join(tmp, ...day.split("/"));
		mkdirSync(dir, { recursive: true });
		const path = join(dir, name);
		writeFileSync(path, "{}\n");
		utimesSync(path, mtimeSec, mtimeSec);
		return path;
	}

	it("picks the newest rollout by mtime, even from an older day dir (midnight-spanning session)", () => {
		writeRollout("2026/07/05", "rollout-2026-07-05T01-00-00-b.jsonl", 2_000_000);
		const live = writeRollout("2026/07/04", "rollout-2026-07-04T22-00-00-a.jsonl", 3_000_000);
		expect(findLatestCodexRollout(tmp)).toBe(live);
	});

	it("ignores non-rollout files and returns null on an empty root", () => {
		expect(findLatestCodexRollout(tmp)).toBeNull();
		const dir = join(tmp, "2026", "07", "05");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "notes.txt"), "x");
		expect(findLatestCodexRollout(tmp)).toBeNull();
	});

	it("returns null for a missing root", () => {
		expect(findLatestCodexRollout(join(tmp, "missing"))).toBeNull();
	});
});

describe("readCodexSnapshot", () => {
	it("extracts the last rate_limits event from the newest rollout tail", () => {
		const dir = join(tmp, "2026", "07", "05");
		mkdirSync(dir, { recursive: true });
		const lines = [
			JSON.stringify({ timestamp: "2026-07-05T10:00:00Z", type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 10 } } } }),
			JSON.stringify({ timestamp: "2026-07-05T11:00:00Z", type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 66, window_minutes: 300 }, credits: { has_credits: true, balance: "7" } } } }),
		];
		writeFileSync(join(dir, "rollout-2026-07-05T10-00-00-x.jsonl"), lines.join("\n") + "\n");
		const snap = readCodexSnapshot(tmp);
		expect(snap!.source).toBe("codex");
		expect(snap!.accountId).toBeUndefined();
		expect(snap!.windows[0].usedPercent).toBe(66);
		expect(snap!.creditsBalance).toBe("7");
		expect(readCodexSnapshot(tmp, "codex-account")?.accountId).toBe("codex-account");
	});

	it("returns null when no rollouts exist", () => {
		expect(readCodexSnapshot(tmp)).toBeNull();
	});
});
