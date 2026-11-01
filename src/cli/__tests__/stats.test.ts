import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleApprovals, handleStats } from "../commands/stats";
import { productivityEventActiveSince, usageDayOverlapsSince } from "../../shared/cli-json/stats";
import type { CliContext } from "../context";
import type { ParsedArgs } from "../args";
import type { AgentUsageDay, CliResponse, ProductivityStatEvent, SystemMemorySnapshot, TaskUsageReport, TaskUsageTotals } from "../../shared/types";
import type { AgentRateLimitsReport } from "../../shared/rate-limits";
import type { PendingApprovalSummary } from "../../shared/agent-approval";
import { CLI_EXIT_CODE_COMMAND_FAILED, CLI_EXIT_CODE_USAGE_ERROR } from "../../shared/cli-exit-codes";

vi.mock("../socket-client", () => ({ sendRequest: vi.fn() }));
vi.mock("../context", async (importOriginal) => ({
	...(await importOriginal<typeof import("../context")>()),
	readProjectDirect: vi.fn((id: string) => (KNOWN_PROJECTS.includes(id) ? { id, name: "p", path: "/p" } : null)),
}));

import { sendRequest } from "../socket-client";
const mockSend = vi.mocked(sendRequest);

const SOCKET = "/tmp/test.sock";
const CTX: CliContext = { projectId: "proj-001", taskId: "aaaaaaaa-1111-2222-3333-444444444444", socketPath: SOCKET };
const PROJECT_A = "aaaaaaaa-0000-0000-0000-000000000001";
const PROJECT_B = "bbbbbbbb-0000-0000-0000-000000000002";
const KNOWN_PROJECTS = [PROJECT_A, PROJECT_B];

// Typed against the app's own types: renaming a field there breaks lint here,
// which is the warning that the --json contract is about to change.
function statEvent(overrides: Partial<ProductivityStatEvent> = {}): ProductivityStatEvent {
	return {
		taskId: "t1", seq: 12, projectId: PROJECT_A, projectName: "dev-3.0", projectKind: "git", title: "Add stats CLI",
		status: "completed", createdAt: "2026-10-01T10:00:00.000Z", movedAt: "2026-10-02T10:00:00.000Z",
		lifecycleStartedAt: null, insertions: 120, deletions: 30, files: 4, liveStats: false, agentId: null,
		groupId: null, variantIndex: null, statusEnteredAt: null, focusMs: 0, focusByHour: {}, movements: [],
		movementsDropped: 0, hibernated: false, configId: null,
		...overrides,
	};
}

function usageDay(overrides: Partial<AgentUsageDay> = {}): AgentUsageDay {
	return {
		date: "2026-10-20", startMs: new Date(2026, 9, 20).getTime(), source: "claude", inputTokens: 1500,
		outputTokens: 2_500_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUsd: 3.5, fullyPriced: true,
		...overrides,
	};
}

function approval(overrides: Partial<PendingApprovalSummary> = {}): PendingApprovalSummary {
	return {
		requestId: "r1", kind: "complete", taskId: "task-1", projectId: PROJECT_A, taskTitle: "Finish", seqLabel: "42",
		projectName: "dev-3.0", requesterTaskId: null, requesterSeq: null, requesterTitle: null, requesterSenderId: null,
		createdAt: "2026-10-27T08:00:00.000Z",
		autoApproveAt: null, heldByUser: false,
		...overrides,
	};
}

function usageTotals(overrides: Partial<TaskUsageTotals> = {}): TaskUsageTotals {
	return {
		messages: 12, inputTokens: 300, outputTokens: 40_000, cacheWriteTokens: 150_000, cacheWrite5mTokens: 0, cacheWrite1hTokens: 150_000,
		cacheReadTokens: 2_000_000, costUsd: 4.3, fullyPriced: true,
		...overrides,
	};
}

function taskUsageReport(overrides: Partial<TaskUsageReport> = {}): TaskUsageReport {
	return {
		taskId: "t1", projectId: PROJECT_A, seq: 11, title: "Fix heartbeats", status: "completed",
		workingDir: "/w/88145048/worktree", worktreeExists: false,
		totals: usageTotals(), models: [{ model: "claude-opus-5-5", ...usageTotals() }],
		coverage: {
			transcriptFiles: 3, subagentTranscriptFiles: 1, resumedTranscriptFiles: 0, uncoveredArchivedSessions: 0, unsupportedArchivedSessions: 0,
			sharedWorkingDir: false, sources: ["claude"],
			firstAt: "2026-09-30T14:45:54.381Z", lastAt: "2026-09-30T15:57:21.940Z",
		},
		...overrides,
	};
}

const ok = (data: unknown): CliResponse => ({ id: "x", ok: true, data });
const fail = (error: string): CliResponse => ({ id: "x", ok: false, error });
const args = (flags: Record<string, string> = {}): ParsedArgs => ({ positional: [], flags });
const json = () => JSON.parse(stdout);

let stdout: string;
let stderr: string;
let spies: Array<{ mockRestore(): void }>;

beforeEach(() => {
	stdout = "";
	stderr = "";
	spies = [
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }),
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }),
		vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => { throw new Error(`EXIT_${code ?? 0}`); }),
	];
	mockSend.mockReset();
});

afterEach(() => spies.forEach((spy) => spy.mockRestore()));

describe("dev3 stats productivity", () => {
	it("prints a versioned JSON object, across all projects by default", async () => {
		mockSend.mockResolvedValue(ok({ events: [statEvent(), statEvent({ taskId: "t2", projectId: PROJECT_B })], generatedAt: "G" }));
		await handleStats("productivity", args({ json: "true" }), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "stats.productivity", {});
		expect(json()).toMatchObject({ schemaVersion: 1, generatedAt: "G", since: null, projectId: null });
		expect(json().events).toHaveLength(2);
		expect(json().events[0].seq).toBe(12);
	});

	it("narrows by --project and --since", async () => {
		mockSend.mockResolvedValue(ok({
			events: [
				statEvent({ taskId: "old" }),
				statEvent({ taskId: "fresh", movedAt: new Date().toISOString() }),
				statEvent({ taskId: "other-project", projectId: PROJECT_B, movedAt: new Date().toISOString() }),
			],
			generatedAt: "G",
		}));
		await handleStats("productivity", args({ json: "true", project: PROJECT_A, since: "7d" }), SOCKET, CTX);
		expect(json().events.map((e: ProductivityStatEvent) => e.taskId)).toEqual(["fresh"]);
		expect(json().projectId).toBe(PROJECT_A);
		expect(json().since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("fails on a --project that matches no project instead of printing an empty result", async () => {
		await expect(handleStats("productivity", args({ json: "true", project: "zzzzzzzz" }), SOCKET, CTX)).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_COMMAND_FAILED}`);
		expect(stderr).toContain("Project not found: zzzzzzzz");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("reads a bare --since date as local midnight", async () => {
		mockSend.mockResolvedValue(ok({ events: [], generatedAt: "G" }));
		await handleStats("productivity", args({ json: "true", since: "2026-10-01" }), SOCKET, CTX);
		expect(json().since).toBe(new Date(2026, 9, 1).toISOString());
	});

	it("refuses an impossible date instead of rolling it into the next month", async () => {
		await expect(handleStats("productivity", args({ since: "2026-02-31" }), SOCKET, CTX)).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`);
		expect(stderr).toContain("Unparseable --since value: 2026-02-31");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("says a too-short --project prefix is too short, not missing", async () => {
		await expect(handleStats("productivity", args({ project: "aaaaaaa" }), SOCKET, null)).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`);
		expect(stderr).toContain("--project prefix too short");
	});

	it("rejects a stray positional", async () => {
		await expect(handleStats("productivity", { positional: ["foo"], flags: {} }, SOCKET, CTX)).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`);
	});

	it("refuses an unparseable --since before asking the app", async () => {
		await expect(handleStats("productivity", args({ since: "last week" }), SOCKET, CTX)).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`);
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("renders a table with a totals line", async () => {
		mockSend.mockResolvedValue(ok({ events: [statEvent()], generatedAt: "G" }));
		await handleStats("productivity", args(), SOCKET, CTX);
		expect(stdout).toContain("Add stats CLI");
		expect(stdout).toContain("1 task: 1 completed, +120 -30 lines.");
	});

	it("tells the user to update an app that predates the method", async () => {
		mockSend.mockResolvedValue(fail("Unknown method: stats.productivity"));
		await expect(handleStats("productivity", args(), SOCKET, CTX)).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_COMMAND_FAILED}`);
		expect(stderr).toContain("older than this CLI");
	});
});

describe("activity filters", () => {
	it("counts a task touched after the cutoff by any timestamp, including a movement", () => {
		const since = "2026-10-10T00:00:00.000Z";
		expect(productivityEventActiveSince(statEvent(), since)).toBe(false);
		expect(productivityEventActiveSince(statEvent({ movements: [{ at: "2026-10-11T00:00:00.000Z", to: "in-progress" }] }), since)).toBe(true);
		expect(productivityEventActiveSince(statEvent({ statusEnteredAt: "2026-10-10T00:00:00.000Z" }), since)).toBe(true);
	});

	it("ends a 25-hour DST day at the next local midnight, not 24 hours in", () => {
		const tz = process.env.TZ;
		process.env.TZ = "Europe/Berlin";
		try {
			// 2026-10-25 is 25 hours long in Berlin; 23:30 local is 24.5 h after its midnight.
			const day = usageDay({ date: "2026-10-25", startMs: new Date(2026, 9, 25).getTime() });
			expect(usageDayOverlapsSince(day, new Date(2026, 9, 25, 23, 30).toISOString())).toBe(true);
			expect(usageDayOverlapsSince(day, new Date(2026, 9, 26).toISOString())).toBe(false);
		} finally {
			process.env.TZ = tz;
		}
	});

	it("keeps a usage day the cutoff falls inside", () => {
		expect(usageDayOverlapsSince(usageDay(), new Date(2026, 9, 20, 18).toISOString())).toBe(true);
		expect(usageDayOverlapsSince(usageDay(), new Date(2026, 9, 21).toISOString())).toBe(false);
	});
});

describe("dev3 stats usage", () => {
	it("prints days with the unpriced flag", async () => {
		mockSend.mockResolvedValue(ok({ days: [usageDay({ fullyPriced: false })], generatedAt: "G", hasUnpricedModels: true }));
		await handleStats("usage", args({ json: "true" }), SOCKET, CTX);
		expect(json()).toMatchObject({ schemaVersion: 1, hasUnpricedModels: true, since: null, days: [{ source: "claude", costUsd: 3.5 }] });
	});

	it("recomputes hasUnpricedModels for the days --since kept", async () => {
		mockSend.mockResolvedValue(ok({
			days: [usageDay({ fullyPriced: false }), usageDay({ date: "2099-01-01", startMs: new Date(2099, 0, 1).getTime() })],
			generatedAt: "G", hasUnpricedModels: true,
		}));
		await handleStats("usage", args({ json: "true", since: "2098-12-31" }), SOCKET, CTX);
		expect(json()).toMatchObject({ hasUnpricedModels: false, days: [{ date: "2099-01-01" }] });
	});

	it("takes --project only with --task, and says why", async () => {
		await expect(handleStats("usage", args({ project: PROJECT_A }), SOCKET, CTX)).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`);
		expect(stderr).toContain("per agent and day");
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("renders tokens compactly and the total cost", async () => {
		mockSend.mockResolvedValue(ok({ days: [usageDay()], generatedAt: "G", hasUnpricedModels: false }));
		await handleStats("usage", args(), SOCKET, CTX);
		expect(stdout).toContain("2.5M");
		expect(stdout).toContain("Total API-equivalent cost: $3.50.");
	});
});

describe("dev3 stats usage --task", () => {
	it("asks the app for one task, scoped to the shell's project, and prints the versioned report", async () => {
		mockSend.mockResolvedValue(ok(taskUsageReport()));
		await handleStats("usage", args({ task: "seq:11", json: "true" }), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "stats.taskUsage", { taskId: "seq:11", projectId: "proj-001" });
		expect(json()).toMatchObject({
			schemaVersion: 1, seq: 11, worktreeExists: false,
			totals: { cacheWrite1hTokens: 150_000, costUsd: 4.3 }, coverage: { subagentTranscriptFiles: 1 },
		});
	});

	it("lets --project pick another board", async () => {
		mockSend.mockResolvedValue(ok(taskUsageReport()));
		await handleStats("usage", args({ task: "seq:11", project: PROJECT_B, json: "true" }), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "stats.taskUsage", { taskId: "seq:11", projectId: PROJECT_B });
	});

	it("refuses --since, because a task's cost is reported whole", async () => {
		await expect(handleStats("usage", args({ task: "seq:11", since: "7d" }), SOCKET, CTX)).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`);
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("needs a value for --task", async () => {
		await expect(handleStats("usage", args({ task: "true" }), SOCKET, CTX)).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`);
	});

	it("renders per-model rows, a total and the coverage, flagging a lower bound", async () => {
		mockSend.mockResolvedValue(ok(taskUsageReport({
			totals: usageTotals({ fullyPriced: false }),
			coverage: { ...taskUsageReport().coverage, uncoveredArchivedSessions: 2, unsupportedArchivedSessions: 1, sharedWorkingDir: true },
		})));
		await handleStats("usage", args({ task: "seq:11" }), SOCKET, CTX);
		expect(stdout).toContain("Task #11 Fix heartbeats (completed)");
		expect(stdout).toContain("(removed)");
		expect(stdout).toContain("TOTAL");
		expect(stdout).toContain("0 / 150.0k");
		expect(stdout).toContain("4.30+");
		expect(stdout).toContain("Read 3 transcript files (1 subagent); agents: claude.");
		expect(stdout).toContain("2 archived session(s) no longer have a transcript");
		expect(stdout).toContain("1 archived session(s) of other agents");
		expect(stdout).toContain("Shared folder: only usage inside the task's lifetime");
	});

	it("says how many transcripts a pane resumed from another folder", async () => {
		const report = taskUsageReport();
		mockSend.mockResolvedValue(ok({ ...report, coverage: { ...report.coverage, resumedTranscriptFiles: 2 } }));
		await handleStats("usage", args({ task: "seq:11" }), SOCKET, CTX);
		expect(stdout).toContain("(1 subagent, 2 resumed from another folder)");
	});

	it("gives the update hint on an app that predates it", async () => {
		mockSend.mockResolvedValue(fail("Unknown method: stats.taskUsage"));
		await expect(handleStats("usage", args({ task: "seq:11" }), SOCKET, CTX)).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_COMMAND_FAILED}`);
		expect(stderr).toContain("older than this CLI");
	});
});

describe("dev3 stats limits", () => {
	const report: AgentRateLimitsReport = {
		generatedAt: 5,
		snapshots: [{
			source: "claude", accountId: null, capturedAt: 4, windows: [{ id: "five_hour", usedPercent: 41.6, resetsAt: 9, windowMinutes: 300 }],
			creditsBalance: null, monthlyCredits: null, planType: null,
		}],
	};

	it("keeps capturedAt in JSON and defaults sessions to an empty list", async () => {
		mockSend.mockResolvedValue(ok(report));
		await handleStats("limits", args({ json: "true" }), SOCKET, CTX);
		expect(json()).toMatchObject({ schemaVersion: 1, generatedAt: new Date(5).toISOString(), sessions: [], snapshots: [{ capturedAt: 4 }] });
	});

	it("renders one row per window", async () => {
		mockSend.mockResolvedValue(ok(report));
		await handleStats("limits", args(), SOCKET, CTX);
		expect(stdout).toContain("five_hour");
		expect(stdout).toContain("42%");
	});
});

describe("dev3 stats memory", () => {
	it("reports a not-yet-sampled monitor as snapshot null", async () => {
		mockSend.mockResolvedValue(ok(null));
		await handleStats("memory", args({ json: "true" }), SOCKET, CTX);
		expect(json()).toEqual({ schemaVersion: 1, snapshot: null });
	});

	it("renders pressure and the heaviest tasks", async () => {
		const gib = 1024 ** 3;
		const snapshot: SystemMemorySnapshot = {
			headroom: 8 * gib, used: 24 * gib, total: 32 * gib, cached: 2 * gib, pressure: "normal", pressureEstimated: false,
			swapUsed: 0, swapTotal: 0, swapping: false, topConsumers: [], appRss: gib, activeTaskCount: 1,
			tasksRssApprox: 3 * gib, medianTaskRss: 3 * gib,
			topTasks: [{ shortId: "a27b4229", taskId: "a27b4229-full", title: "Stats CLI", projectId: PROJECT_A, rss: 3 * gib }],
		};
		mockSend.mockResolvedValue(ok(snapshot));
		await handleStats("memory", args(), SOCKET, CTX);
		expect(stdout).toContain("Pressure:  normal");
		expect(stdout).toContain("a27b4229");
	});

	it("marks a live task the board cannot name instead of printing an empty title", async () => {
		const gib = 1024 ** 3;
		mockSend.mockResolvedValue(ok({
			headroom: gib, used: gib, total: 2 * gib, cached: 0, pressure: "warn", pressureEstimated: false, swapUsed: 0,
			swapTotal: 0, swapping: false, topConsumers: [], appRss: gib, activeTaskCount: 1, tasksRssApprox: gib,
			medianTaskRss: gib, topTasks: [{ shortId: "deadbeef", taskId: null, title: "", projectId: "", rss: gib }],
		} satisfies SystemMemorySnapshot));
		await handleStats("memory", args(), SOCKET, CTX);
		expect(stdout).toMatch(/deadbeef\s+1\.0 GB\s+-/);
	});
});

describe("dev3 stats prices", () => {
	const OPUS = { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 };
	const pricesArgs = (models: string[], json = true): ParsedArgs => ({
		positional: [], flags: { ...(json ? { json: "true" } : {}), ...(models.length ? { model: models[models.length - 1] } : {}) },
		repeated: models.length ? { model: models } : {},
	});

	it("prints exactly the agreed contract, priced and unpriced, and exits 0", async () => {
		mockSend.mockResolvedValue(ok({ fetchedAt: 0, models: [{ model: "claude-opus-5-5[1m]", rate: OPUS }, { model: "mystery", rate: null }] }));
		await handleStats("prices", pricesArgs(["claude-opus-5-5[1m]", "mystery"]), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "stats.prices", { models: ["claude-opus-5-5[1m]", "mystery"] });
		expect(json()).toEqual({
			schemaVersion: 1, currency: "USD", unit: "per 1M tokens", source: "refreshed", fetchedAt: "1970-01-01T00:00:00.000Z",
			models: [{ model: "claude-opus-5-5[1m]", priced: true, ...OPUS }, { model: "mystery", priced: false }],
		});
	});

	it("says built-in with no refreshed table, and asks the app for every seen model when no --model is given", async () => {
		mockSend.mockResolvedValue(ok({ fetchedAt: null, models: [] }));
		await handleStats("prices", pricesArgs([]), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "stats.prices", {});
		expect(json()).toMatchObject({ source: "built-in", fetchedAt: null, models: [] });
	});

	it("renders a table with unpriced rows marked", async () => {
		mockSend.mockResolvedValue(ok({ fetchedAt: null, models: [{ model: "claude-opus-5-5", rate: OPUS }, { model: "mystery", rate: null }] }));
		await handleStats("prices", pricesArgs(["claude-opus-5-5", "mystery"], false), SOCKET, CTX);
		expect(stdout).toMatch(/claude-opus-5-5\s+\$4\s+\$20\s+\$5\s+\$8\s+\$0\.2/);
		expect(stdout).toMatch(/mystery\s+not priced/);
		expect(stdout).toContain("built-in prices");
	});

	it("is a usage error for an empty --model, before asking the app", async () => {
		await expect(handleStats("prices", pricesArgs(["claude-opus-5-5", "true"]), SOCKET, CTX)).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`);
		expect(mockSend).not.toHaveBeenCalled();
	});

	it("gives the update hint on an app that predates it", async () => {
		mockSend.mockResolvedValue(fail("Unknown method: stats.prices"));
		await expect(handleStats("prices", pricesArgs(["x"]), SOCKET, CTX)).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_COMMAND_FAILED}`);
		expect(stderr).toContain("older than this CLI");
	});
});

describe("dev3 approvals list", () => {
	it("prints pending requests, filtered by --project", async () => {
		mockSend.mockResolvedValue(ok({ requests: [approval(), approval({ requestId: "r2", projectId: PROJECT_B })] }));
		await handleApprovals("list", args({ json: "true", project: PROJECT_A }), SOCKET, CTX);
		expect(mockSend).toHaveBeenCalledWith(SOCKET, "approvals.list", {});
		expect(json()).toMatchObject({ schemaVersion: 1, projectId: PROJECT_A, requests: [{ requestId: "r1" }] });
		expect(json().requests).toHaveLength(1);
	});

	it("names who asked for a launch", async () => {
		mockSend.mockResolvedValue(ok({ requests: [
			approval({ kind: "launch", requesterSeq: 33 }),
			approval({ requestId: "r2", kind: "launch", requesterSenderId: "openclaw", heldByUser: true }),
		] }));
		await handleApprovals("list", args(), SOCKET, CTX);
		expect(stdout).toContain("#33");
		expect(stdout).toContain("sender openclaw");
		expect(stdout).toContain("held by user");
	});

	it("needs the list verb", async () => {
		await expect(handleApprovals(undefined, args(), SOCKET, CTX)).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`);
	});
});

describe("dev3 stats", () => {
	it("rejects an unknown subcommand", async () => {
		await expect(handleStats("tokens", args(), SOCKET, CTX)).rejects.toThrow(`EXIT_${CLI_EXIT_CODE_USAGE_ERROR}`);
	});
});
