import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project, Task, TaskStatus } from "../../shared/types";
import { parseClaudeSessionStats } from "../../shared/session-stats";
import {
	attachTaskIdentity,
	buildClaudeManagedSettings,
	findLatestCodexRollout,
	readClaudeSessionDumps,
	readClaudeSnapshot,
	readCodexSnapshot,
} from "../rate-limit-monitor";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "dev3-rl-test-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("buildClaudeManagedSettings", () => {
	it("always suppresses the dangerous-mode permission prompt", () => {
		expect(buildClaudeManagedSettings("/bin/dev3", false)).toEqual({
			skipDangerousModePermissionPrompt: true,
		});
	});

	it("keeps the skip flag and adds the statusLine wrapper when tracking is on", () => {
		const s = buildClaudeManagedSettings("/bin/dev3", true);
		expect(s.skipDangerousModePermissionPrompt).toBe(true);
		expect(s.statusLine).toEqual({ type: "command", command: '"/bin/dev3" statusline' });
	});
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

describe("readClaudeSessionDumps", () => {
	const payload = (percent: number) => ({ model: { display_name: "Opus" }, context_window: { used_percentage: percent } });

	it("reads recent per-task dumps newest first, keyed by file name", () => {
		const now = Date.now();
		writeFileSync(join(tmp, "task-a.json"), JSON.stringify({ capturedAt: now - 60_000, payload: payload(10) }));
		writeFileSync(join(tmp, "task-b.json"), JSON.stringify({ capturedAt: now - 1_000, payload: payload(20) }));
		const sessions = readClaudeSessionDumps(tmp, now);
		expect(sessions.map((s) => [s.taskId, s.contextPercent])).toEqual([
			["task-b", 20],
			["task-a", 10],
		]);
	});

	it("skips stale, corrupt and non-session dumps", () => {
		const now = Date.now();
		writeFileSync(join(tmp, "old.json"), JSON.stringify({ capturedAt: now - 7 * 3_600_000, payload: payload(1) }));
		writeFileSync(join(tmp, "torn.json"), "{not json");
		writeFileSync(join(tmp, "empty.json"), JSON.stringify({ capturedAt: now, payload: { rate_limits: {} } }));
		expect(readClaudeSessionDumps(tmp, now)).toEqual([]);
	});

	it("returns nothing when the directory does not exist", () => {
		expect(readClaudeSessionDumps(join(tmp, "missing"))).toEqual([]);
	});
});

describe("attachTaskIdentity", () => {
	const session = (taskId: string, capturedAt: number) =>
		parseClaudeSessionStats({ model: { display_name: "Opus" }, context_window: { used_percentage: 5 } }, taskId, capturedAt)!;
	const project = (id: string) => ({ id, name: id }) as Project;
	const task = (id: string, status: TaskStatus = "in-progress") => ({ id, seq: 1, title: id, status }) as Task;

	it("lists every live session uncapped, and marks tasks waiting on the user", async () => {
		const ids = Array.from({ length: 12 }, (_, i) => `b${i}`);
		const out = await attachTaskIdentity(
			ids.map((id, i) => session(id, 1000 - i)),
			{
				projects: async () => [project("B")],
				tasks: async () => ids.map((id, i) => task(id, i === 0 ? "user-questions" : i === 1 ? "review-by-user" : "in-progress")),
			},
		);
		expect(out).toHaveLength(ids.length);
		expect(out.filter((s) => s.awaitingUser).map((s) => s.taskId)).toEqual(["b0", "b1"]);
		expect(out[0]).toMatchObject({ projectId: "B", projectName: "B", taskTitle: "b0" });
	});

	it("keeps other projects' sessions when one board cannot be read, and drops finished tasks", async () => {
		const out = await attachTaskIdentity([session("x", 2), session("y", 1)], {
			projects: async () => [project("broken"), project("ok")],
			tasks: async (p) => {
				if (p.id === "broken") throw new Error("corrupt tasks.json");
				return [task("x"), task("y", "completed")];
			},
		});
		expect(out.map((s) => s.taskId)).toEqual(["x"]);
	});
});
