import type { AgentUsageDay, AgentUsageReport, ProductivityStatEvent, ProductivityStats, SystemMemorySnapshot, TaskUsageReport } from "../../shared/types";
import type { AgentRateLimitsReport } from "../../shared/rate-limits";
import type { PendingApprovalSummary } from "../../shared/agent-approval";
import type { ModelRate } from "../../shared/agent-pricing";
import { parseEventCursor } from "../../shared/board-events";
import { sendRequest } from "../socket-client";
import { exitError, exitUsage, printTable } from "../output";
import type { ParsedArgs } from "../args";
import { ID_PREFIX_MIN_LENGTH } from "../../shared/types";
import { expandShortId, expandShortProjectId, readProjectDirect, resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";

/**
 * `--json` output is a public contract like `task show --json`: additive changes
 * keep the version, removing or renaming a field bumps it.
 */
export const STATS_JSON_SCHEMA_VERSION = 1;

const MAX_HUMAN_ROWS = 50;

function printJson(payload: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify({ schemaVersion: STATS_JSON_SCHEMA_VERSION, ...payload }, null, 2)}\n`);
}

/** Flags only: a stray word is a typo, and ignoring it would answer a different question. */
function rejectPositionals(args: ParsedArgs, usage: string): void {
	if (args.positional.length > 0) exitUsage(`Unexpected argument: ${args.positional[0]}\nUsage: ${usage}`);
}

/**
 * `--since 7d` / a date / a timestamp, resolved to ISO; null when not given. A bare
 * date is LOCAL midnight, the clock usage days are cut on; a timestamp is UTC, as in
 * `dev3 events --from`.
 */
function readSince(args: ParsedArgs): string | null {
	const raw = args.flags.since;
	if (raw === undefined) return null;
	if (raw === "true") exitUsage("--since needs a value, e.g. --since 7d");
	const since = /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())
		? localMidnight(raw.trim())
		: parseEventCursor(raw);
	if (!since) {
		exitUsage(`Unparseable --since value: ${raw}. Use a duration (30m, 12h, 7d, 2w), a date (2026-10-01, local midnight) or a UTC timestamp (2026-10-01T09:00:00).`);
	}
	return since;
}

/** Null for an impossible date: `new Date` would roll 2026-02-31 over to March. */
function localMidnight(date: string): string | null {
	const [y, m, d] = date.split("-").map(Number);
	const at = new Date(y, m - 1, d);
	if (at.getFullYear() !== y || at.getMonth() !== m - 1 || at.getDate() !== d) return null;
	return at.toISOString();
}

/** Filtering happens here, so an id that matches no project must fail — not print an empty result. */
function readProject(args: ParsedArgs, context: CliContext | null): string | null {
	const raw = args.flags.project;
	if (raw === undefined) return null;
	if (raw === "true") exitUsage("--project needs a project id");
	const id = expandShortProjectId(raw, context);
	if (id.length < ID_PREFIX_MIN_LENGTH) exitUsage(`--project prefix too short: ${raw}. Use at least ${ID_PREFIX_MIN_LENGTH} characters.`);
	if (readProjectDirect(id)?.id !== id) exitError(`Project not found: ${raw}`, "Run `dev3 projects list` for the ids.");
	return id;
}

async function request<T>(socketPath: string, method: string, what: string, params: Record<string, unknown> = {}): Promise<T> {
	const resp = await sendRequest(socketPath, method, params);
	if (!resp.ok) {
		if ((resp.error ?? "").startsWith("Unknown method:")) {
			exitError(resp.error!, `The running dev3 app is older than this CLI and has no \`${what}\`. Update or restart the app, then retry.`);
		}
		exitError(resp.error || `Failed to read ${what}`);
	}
	return resp.data as T;
}

/** A task counts when anything happened to it at or after `since`. */
export function productivityEventActiveSince(event: ProductivityStatEvent, since: string): boolean {
	const sinceMs = Date.parse(since);
	const after = (iso: string | null) => iso !== null && Date.parse(iso) >= sinceMs;
	return after(event.createdAt) || after(event.movedAt) || after(event.statusEnteredAt)
		|| event.movements.some((m) => after(m.at));
}

/** A day counts when any part of it falls at or after `since`. Days are local, so a DST day is 23 or 25 hours. */
export function usageDayOverlapsSince(day: AgentUsageDay, since: string): boolean {
	const start = new Date(day.startMs);
	const nextMidnight = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1).getTime();
	return nextMidnight > Date.parse(since);
}

function lastActivity(event: ProductivityStatEvent): string {
	return event.movedAt ?? event.createdAt;
}

function truncate(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function formatWhen(ms: number | string | null): string {
	if (ms === null) return "-";
	return new Date(ms).toLocaleString("en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function gb(bytes: number): string {
	return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function tokens(n: number): string {
	if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return String(n);
}

function moreLine(shown: number, total: number): void {
	if (total > shown) process.stdout.write(`… ${total - shown} more not shown — use --json for all of them.\n`);
}

async function productivity(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["project", "since", "json"]);
	rejectPositionals(args, "dev3 stats productivity [--project <id>] [--since <duration|date>] [--json]");
	const since = readSince(args);
	const projectId = readProject(args, context);
	const stats = await request<ProductivityStats>(socketPath, "stats.productivity", "stats productivity");
	const events = stats.events.filter((e) =>
		(!projectId || e.projectId === projectId) && (!since || productivityEventActiveSince(e, since)));

	if (args.flags.json === "true") {
		printJson({ generatedAt: stats.generatedAt, since, projectId, events });
		return;
	}
	if (events.length === 0) {
		process.stdout.write("No tasks\n");
		return;
	}
	const sorted = [...events].sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));
	const shown = sorted.slice(0, MAX_HUMAN_ROWS);
	printTable(
		["SEQ", "STATUS", "PROJECT", "+", "-", "FILES", "LAST MOVE", "TITLE"],
		shown.map((e) => [
			String(e.seq), e.status, truncate(e.projectName, 18), String(e.insertions), String(e.deletions),
			String(e.files), formatWhen(lastActivity(e)), truncate(e.title, 50),
		]),
	);
	moreLine(shown.length, sorted.length);
	const completed = events.filter((e) => e.status === "completed").length;
	const insertions = events.reduce((sum, e) => sum + e.insertions, 0);
	const deletions = events.reduce((sum, e) => sum + e.deletions, 0);
	process.stdout.write(
		`\n${events.length} task${events.length === 1 ? "" : "s"}${since ? ` active since ${since}` : ""}: ` +
		`${completed} completed, +${insertions} -${deletions} lines.\n`,
	);
}

const USAGE_SYNOPSIS = "dev3 stats usage [--since <duration|date>] [--json]\n       dev3 stats usage --task <id|seq:N> [--project <id>] [--json]";

async function usage(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["task", "project", "since", "json"]);
	rejectPositionals(args, USAGE_SYNOPSIS);
	if (args.flags.task !== undefined) return taskUsage(args, socketPath, context);
	if (args.flags.project !== undefined) {
		exitUsage("dev3 stats usage --project needs --task: daily usage is recorded per agent and day, not per project.");
	}
	const since = readSince(args);
	const report = await request<AgentUsageReport>(socketPath, "stats.usage", "stats usage");
	const days = since ? report.days.filter((d) => usageDayOverlapsSince(d, since)) : report.days;

	if (args.flags.json === "true") {
		printJson({ generatedAt: report.generatedAt, since, hasUnpricedModels: days.some((d) => !d.fullyPriced), days });
		return;
	}
	if (days.length === 0) {
		process.stdout.write("No agent usage recorded\n");
		return;
	}
	const newestFirst = [...days].reverse();
	const shown = newestFirst.slice(0, MAX_HUMAN_ROWS);
	printTable(
		["DATE", "AGENT", "INPUT", "OUTPUT", "CACHE WRITE", "CACHE READ", "COST (API $)"],
		shown.map((d) => [
			d.date, d.source, tokens(d.inputTokens), tokens(d.outputTokens), tokens(d.cacheCreationInputTokens),
			tokens(d.cacheReadInputTokens), `${d.costUsd.toFixed(2)}${d.fullyPriced ? "" : "+"}`,
		]),
	);
	moreLine(shown.length, newestFirst.length);
	const cost = days.reduce((sum, d) => sum + d.costUsd, 0);
	process.stdout.write(`\nTotal API-equivalent cost: $${cost.toFixed(2)}${days.some((d) => !d.fullyPriced) ? " (lower bound: some models have no known price, marked +)" : ""}.\n`);
}

/** Codex writes carry no TTL, so they count in the total and in neither split. */
function cacheWriteSplit(t: TaskUsageReport["totals"]): string {
	return `${tokens(t.cacheWrite5mTokens)} / ${tokens(t.cacheWrite1hTokens)}`;
}

/** One task, not a day: `--since` would cut a task's cost in two, so it is refused. */
async function taskUsage(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	const raw = args.flags.task;
	if (raw === "true" || !raw.trim()) exitUsage("--task needs a task id or seq:N");
	if (args.flags.since !== undefined) exitUsage("--since cannot be combined with --task: a task's usage is reported whole.");
	const params: Record<string, unknown> = { taskId: expandShortId(raw.trim(), context) };
	const projectId = resolveProjectId(args.flags.project, context);
	if (projectId) params.projectId = projectId;
	const report = await request<TaskUsageReport>(socketPath, "stats.taskUsage", "stats usage --task", params);

	if (args.flags.json === "true") {
		printJson({ ...report });
		return;
	}
	const { totals, coverage } = report;
	process.stdout.write(`Task #${report.seq} ${truncate(report.title, 60)} (${report.status})\n`);
	process.stdout.write(`Working dir: ${report.workingDir}${report.worktreeExists ? "" : " (removed)"}\n\n`);
	if (report.models.length === 0) {
		process.stdout.write(`No agent usage found in this task's Claude or Codex transcripts${report.coverage.uncoveredArchivedSessions ? ` (${report.coverage.uncoveredArchivedSessions} archived session(s) have no transcript left)` : ""}.\n`);
		return;
	}
	printTable(
		["MODEL", "MESSAGES", "INPUT", "OUTPUT", "CACHE WRITE", "5M / 1H", "CACHE READ", "COST (API $)"],
		[...report.models, { model: "TOTAL", ...totals }].map((m) => [
			m.model, String(m.messages), tokens(m.inputTokens), tokens(m.outputTokens), tokens(m.cacheWriteTokens), cacheWriteSplit(m),
			tokens(m.cacheReadTokens), `${m.costUsd.toFixed(2)}${m.fullyPriced ? "" : "+"}`,
		]),
	);
	process.stdout.write(
		`\nRead ${coverage.transcriptFiles} transcript file${coverage.transcriptFiles === 1 ? "" : "s"} ` +
		`(${coverage.subagentTranscriptFiles} subagent${coverage.resumedTranscriptFiles ? `, ${coverage.resumedTranscriptFiles} resumed from another folder` : ""})` +
		`${coverage.sources.length ? `; agents: ${coverage.sources.join(", ")}` : ""}.\n`,
	);
	if (coverage.sharedWorkingDir) {
		process.stdout.write("Shared folder: only usage inside the task's lifetime is counted, which can include other work run there meanwhile.\n");
	}
	if (coverage.unsupportedArchivedSessions > 0) {
		process.stdout.write(`${coverage.unsupportedArchivedSessions} archived session(s) of other agents (Cursor, …) are not covered by this report.\n`);
	}
	if (coverage.uncoveredArchivedSessions > 0) {
		process.stdout.write(`${coverage.uncoveredArchivedSessions} archived session(s) no longer have a transcript and are not counted: totals are a lower bound.\n`);
	}
	if (!totals.fullyPriced) process.stdout.write("Cost is a lower bound: some models have no known price (marked +).\n");
}

async function limits(args: ParsedArgs, socketPath: string): Promise<void> {
	rejectUnknownFlags(args, ["json"]);
	rejectPositionals(args, "dev3 stats limits [--json]");
	const report = await request<AgentRateLimitsReport>(socketPath, "stats.limits", "stats limits");

	if (args.flags.json === "true") {
		printJson({ generatedAt: new Date(report.generatedAt).toISOString(), snapshots: report.snapshots, sessions: report.sessions ?? [] });
		return;
	}
	if (report.snapshots.length === 0) {
		process.stdout.write("No rate-limit readings yet\n");
		return;
	}
	const rows = report.snapshots.flatMap((s) => {
		const account = s.accountId ?? "system";
		if (s.windows.length === 0) return [[s.source, account, "-", "no limits reported", "-", formatWhen(s.capturedAt)]];
		return s.windows.map((w) => [
			s.source, account, w.id, `${Math.round(w.usedPercent)}%`, formatWhen(w.resetsAt), formatWhen(s.capturedAt),
		]);
	});
	printTable(["AGENT", "ACCOUNT", "WINDOW", "USED", "RESETS", "CAPTURED"], rows);
}

async function memory(args: ParsedArgs, socketPath: string): Promise<void> {
	rejectUnknownFlags(args, ["json"]);
	rejectPositionals(args, "dev3 stats memory [--json]");
	const snapshot = await request<SystemMemorySnapshot | null>(socketPath, "stats.memory", "stats memory");

	if (args.flags.json === "true") {
		printJson({ snapshot });
		return;
	}
	if (!snapshot) {
		process.stdout.write("The memory monitor has not sampled yet — retry in a few seconds.\n");
		return;
	}
	const out = (line: string) => process.stdout.write(`${line}\n`);
	out(`Pressure:  ${snapshot.pressure}${snapshot.pressureEstimated ? " (estimated)" : ""}`);
	out(`Headroom:  ${gb(snapshot.headroom)} of ${gb(snapshot.total)} (used ${gb(snapshot.used)}, cached ${gb(snapshot.cached)})`);
	out(`Swap:      ${gb(snapshot.swapUsed)} of ${gb(snapshot.swapTotal)}${snapshot.swapping ? ", swapping now" : ""}`);
	out(`dev3 app:  ${gb(snapshot.appRss)}`);
	out(`Tasks:     ${snapshot.activeTaskCount} live, ~${gb(snapshot.tasksRssApprox)} (upper bound)`);
	if (snapshot.topTasks.length > 0) {
		out("");
		printTable(["TASK", "RSS", "TITLE"], snapshot.topTasks.map((t) => [t.shortId, gb(t.rss), truncate(t.title || "-", 60)]));
	}
}

interface PricesWire {
	fetchedAt: number | null;
	models: Array<{ model: string; rate: ModelRate | null }>;
}

function usd(n: number): string {
	return `$${Number(n.toFixed(4))}`;
}

async function prices(args: ParsedArgs, socketPath: string): Promise<void> {
	rejectUnknownFlags(args, ["model", "json"]);
	rejectPositionals(args, "dev3 stats prices [--model <id> ...] [--json]");
	const asked = args.repeated?.model ?? (args.flags.model === undefined ? [] : [args.flags.model]);
	if (asked.some((m) => m === "true" || !m.trim())) exitUsage("--model needs a model id, e.g. --model claude-opus-5-5");
	const resp = await sendRequest(socketPath, "stats.prices", asked.length ? { models: asked.map((m) => m.trim()) } : {});
	if (!resp.ok) {
		if ((resp.error ?? "").startsWith("Unknown method:")) {
			exitError(resp.error!, "The running dev3 app is older than this CLI and has no `stats prices`. Update or restart the app, then retry.");
		}
		exitError(resp.error || "Failed to read prices");
	}
	const wire = resp.data as PricesWire;
	const fetchedAt = wire.fetchedAt === null ? null : new Date(wire.fetchedAt).toISOString();
	const source = fetchedAt ? "refreshed" : "built-in";
	const models = wire.models.map(({ model, rate }) => rate
		? { model, priced: true as const, input: rate.input, output: rate.output, cacheWrite5m: rate.cacheWrite5m, cacheWrite1h: rate.cacheWrite1h, cacheRead: rate.cacheRead }
		: { model, priced: false as const });

	if (args.flags.json === "true") {
		printJson({ currency: "USD", unit: "per 1M tokens", source, fetchedAt, models });
		return;
	}
	if (models.length === 0) {
		process.stdout.write("No models seen in local agent usage yet — ask about one with --model <id>.\n");
		return;
	}
	printTable(
		["MODEL", "INPUT", "OUTPUT", "CACHE WRITE 5M", "CACHE WRITE 1H", "CACHE READ"],
		models.map((m) => m.priced
			? [m.model, usd(m.input), usd(m.output), usd(m.cacheWrite5m), usd(m.cacheWrite1h), usd(m.cacheRead)]
			: [m.model, "not priced", "-", "-", "-", "-"]),
	);
	process.stdout.write(
		`\nUSD per 1M tokens, ${source === "refreshed" ? `refreshed prices fetched ${fetchedAt}` : "built-in prices"}` +
		" (a model missing from the refresh falls back to the built-in table).\n",
	);
}

async function approvalsList(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["project", "json"]);
	rejectPositionals(args, "dev3 approvals list [--project <id>] [--json]");
	const projectId = readProject(args, context);
	const { requests } = await request<{ requests: PendingApprovalSummary[] }>(socketPath, "approvals.list", "approvals list");
	const pending = projectId ? requests.filter((r) => r.projectId === projectId) : requests;

	if (args.flags.json === "true") {
		printJson({ projectId, requests: pending });
		return;
	}
	if (pending.length === 0) {
		process.stdout.write("No pending approvals\n");
		return;
	}
	printTable(
		["KIND", "SEQ", "PROJECT", "TASK", "ASKED BY", "SINCE", "AUTO-APPROVES"],
		pending.map((r) => [
			r.kind,
			r.seqLabel ?? r.taskId.slice(0, 8),
			truncate(r.projectName ?? r.projectId.slice(0, 8), 18),
			truncate(r.taskTitle ?? "-", 40),
			r.requesterSenderId ? `sender ${r.requesterSenderId}` : r.requesterSeq !== null ? `#${r.requesterSeq}` : "-",
			formatWhen(r.createdAt),
			r.heldByUser ? "held by user" : formatWhen(r.autoApproveAt),
		]),
	);
}

const STATS_SUBCOMMANDS = ["productivity", "usage", "limits", "memory", "prices"] as const;

export async function handleStats(
	subcommand: string | undefined,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	switch (subcommand) {
		case "productivity":
			return productivity(args, socketPath, context);
		case "usage":
			return usage(args, socketPath, context);
		case "limits":
			return limits(args, socketPath);
		case "memory":
			return memory(args, socketPath);
		case "prices":
			return prices(args, socketPath);
		default:
			exitUsage(`Usage: dev3 stats <${STATS_SUBCOMMANDS.join("|")}> [--json]`);
	}
}

export async function handleApprovals(
	subcommand: string | undefined,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	if (subcommand !== "list") exitUsage("Usage: dev3 approvals list [--project <id>] [--json]");
	return approvalsList(args, socketPath, context);
}
