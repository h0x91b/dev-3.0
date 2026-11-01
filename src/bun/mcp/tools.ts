/**
 * THE allow-list of what an outside agent can do over MCP. Each tool validates its
 * arguments against a closed schema, resolves its project or task against the
 * token's project allow-list BEFORE calling anything, then calls an existing CLI
 * socket handler and answers in CLI `--json` terms. No transport code here: the
 * table would serve a plain JSON API unchanged.
 *
 * Never here, by design: terminal input, `agent.spawn`, settings, complete /
 * cancel / reset, `--to-sender`, lease `takeOver`, and any generic "call method X".
 */

import type { CliResponse, Project, SpacesFile, Task, TaskPriority } from "../../shared/types";
import { ACTIVE_STATUSES, ALL_PRIORITIES, ALL_STATUSES, EMPTY_SPACES_FILE, ID_PREFIX_MIN_LENGTH, normalizePriority } from "../../shared/types";
import type { AgentUsageReport, ProductivityStats, SystemMemorySnapshot, TaskUsageReport } from "../../shared/types";
import type { AgentRateLimitsReport } from "../../shared/rate-limits";
import type { PendingApprovalSummary } from "../../shared/agent-approval";
import { toCliProject } from "../../shared/project-registration";
import { classifyAppError } from "../../shared/cli-errors";
import {
	CLI_EXIT_CODE_APPROVAL_STILL_PENDING,
	CLI_EXIT_CODE_COMMAND_FAILED,
	CLI_EXIT_CODE_DELIVERY_UNCONFIRMED,
	CLI_EXIT_CODE_LAUNCH_DECLINED,
	CLI_EXIT_CODE_RESUME_ALREADY_RUNNING,
	CLI_EXIT_CODE_RESUME_UNAVAILABLE,
	CLI_EXIT_CODE_EVENT_CURSOR_INVALID,
	CLI_EXIT_CODE_MESSAGE_SUBJECT_REQUIRED,
	CLI_EXIT_CODE_SUCCESS,
	CLI_EXIT_CODE_USAGE_ERROR,
} from "../../shared/cli-exit-codes";
import { DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT, isEventIdPrefix, parseEventCursor, type EventSelection } from "../../shared/board-events";
import { buildTaskShowJson, type ShownTask } from "../../shared/cli-json/task-show";
import { buildTasksListJson } from "../../shared/cli-json/tasks-list";
import { taskMutationJson } from "../../shared/cli-json/task-mutation";
import type { CliResumeOutcome } from "../../shared/agent-resume";
import {
	approvalsJson,
	limitsJson,
	memoryJson,
	parseSinceValue,
	pricesJson,
	productivityJson,
	taskUsageJson,
	usageJson,
	type PricesWire,
} from "../../shared/cli-json/stats";
import { MAX_MESSAGE_SUBJECT_LENGTH, checkMessageSubject } from "../../shared/agent-message-subject";
import { SENDER_WAIT_MAX_MS, type SenderWaitResult } from "../../shared/external-senders";
import { MAX_SCHEDULED_MESSAGE_LENGTH } from "../../shared/types";
import { findTaskByRef } from "../cli-socket/task-resolution";
import { validate, type ObjectSchema } from "./schema";
import type { McpScope, McpTokenRecord } from "./token-store";

export type CallApp = (method: string, params: Record<string, unknown>) => Promise<CliResponse>;

export interface ToolContext {
	token: McpTokenRecord;
	senderLabel: string;
	call: CallApp;
	/** Aborts when the HTTP client disconnects. Only read-only parking honours it. */
	signal?: AbortSignal;
	/** Tests shorten the dialog wait. */
	approvalWaitMs?: number;
}

export interface ToolError {
	code: string;
	message: string;
	hint?: string;
	retryAfterS?: number;
}

export interface ToolOutcome {
	exitCode: number;
	json?: unknown;
	error?: ToolError;
}

export interface ToolDef {
	name: string;
	description: string;
	/** null = any valid token. */
	scope: McpScope | null;
	inputSchema: ObjectSchema;
	/** JSON paths in `json` holding ids, enums, timestamps, numbers — everything else is untrusted text. */
	trustedFields: string[];
	/** Exit codes that are not an error for this tool. */
	successCodes: number[];
	/** Holds the connection up to ~25 s; counted against the parked limit. */
	parked?: boolean;
	/** Changes state; counted against the mutating rate limit. */
	mutating?: boolean;
	run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
}

/** Thrown inside a tool to answer with a CLI-shaped failure. */
export class ToolFailure extends Error {
	constructor(readonly outcome: ToolOutcome) {
		super(outcome.error?.message ?? "tool failed");
	}
}

export function fail(exitCode: number, code: string, message: string, extra: Partial<ToolError> = {}, json?: unknown): never {
	throw new ToolFailure({ exitCode, error: { code, message, ...extra }, ...(json === undefined ? {} : { json }) });
}

export function usage(message: string): never {
	fail(CLI_EXIT_CODE_USAGE_ERROR, "USAGE", message);
}

export function scopeDenied(message: string): never {
	fail(CLI_EXIT_CODE_COMMAND_FAILED, "SCOPE_DENIED", message);
}

export function ok(json: unknown): ToolOutcome {
	return { exitCode: CLI_EXIT_CODE_SUCCESS, json };
}

/** One app call; a failure becomes the exit code the CLI would have used for it. */
export async function appData<T>(ctx: ToolContext, method: string, params: Record<string, unknown> = {}): Promise<T> {
	const resp = await ctx.call(method, params);
	if (resp.ok) return resp.data as T;
	const classified = classifyAppError(resp.error);
	fail(classified.exitCode, classified.code, classified.message);
}

export function projectAllowed(token: McpTokenRecord, projectId: string): boolean {
	return token.projects.includes("*") || token.projects.includes(projectId);
}

async function allowedProjects(ctx: ToolContext): Promise<Project[]> {
	const all = await appData<Project[]>(ctx, "projects.list");
	return all.filter((p) => projectAllowed(ctx.token, p.id));
}

/** A project id or ≥8-char prefix, which must be on the token's allow-list. */
export async function resolveProject(ctx: ToolContext, ref: string): Promise<Project> {
	const all = await appData<Project[]>(ctx, "projects.list");
	const matches = all.filter((p) => p.id === ref || (ref.length >= ID_PREFIX_MIN_LENGTH && p.id.startsWith(ref)));
	const exact = matches.find((p) => p.id === ref);
	const project = exact ?? (matches.length === 1 ? matches[0] : null);
	if (!project) {
		if (matches.length > 1) fail(CLI_EXIT_CODE_COMMAND_FAILED, "COMMAND_FAILED", `Ambiguous project prefix "${ref}". Use a longer prefix.`);
		fail(CLI_EXIT_CODE_COMMAND_FAILED, "COMMAND_FAILED", `Project not found: ${ref}`);
	}
	if (!projectAllowed(ctx.token, project.id)) scopeDenied(`Project ${ref} is not on this token's project list.`);
	return project;
}

/**
 * A task ref (id, ≥8-char prefix, or seq:N) resolved ONLY inside the projects this
 * token may see — a task elsewhere is not found, never touched.
 */
export async function resolveTask(ctx: ToolContext, ref: string, projectRef?: string): Promise<{ project: Project; task: Task }> {
	const projects = projectRef ? [await resolveProject(ctx, projectRef)] : await allowedProjects(ctx);
	const found: Array<{ project: Project; task: Task }> = [];
	for (const project of projects) {
		const tasks = await appData<Task[]>(ctx, "tasks.list", { projectId: project.id });
		let task: Task | null;
		try {
			task = findTaskByRef(tasks, ref);
		} catch (err) {
			fail(CLI_EXIT_CODE_COMMAND_FAILED, "COMMAND_FAILED", String(err instanceof Error ? err.message : err));
		}
		if (task) found.push({ project, task });
	}
	if (found.length > 1) usage(`Task ref "${ref}" matches tasks in ${found.length} projects. Pass project.`);
	if (found.length === 0) fail(CLI_EXIT_CODE_COMMAND_FAILED, "COMMAND_FAILED", `Task not found: ${ref}`);
	return found[0];
}

const TASK_REF = { type: "string", minLength: 1, maxLength: 64, description: "Task id, an id prefix of 8+ characters, or seq:N." } as const;
const PROJECT_REF = { type: "string", minLength: 1, maxLength: 64, description: "Project id or an id prefix of 8+ characters." } as const;

function obj(properties: ObjectSchema["properties"], required: string[] = []): ObjectSchema {
	return { type: "object", properties, required, additionalProperties: false };
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

const MUTATION_TRUSTED = ["schemaVersion", "task.id", "task.seq", "task.projectId", "task.status", "task.customColumnId", "task.priority", "task.taskType", "task.manualCompletion", "task.draft"];

// ── read ────────────────────────────────────────────────────────────────────

const projectsList: ToolDef = {
	name: "projects_list",
	description: "List the projects this token may see, as `dev3 projects list --json`.",
	scope: "read",
	inputSchema: obj({}),
	trustedFields: ["[].id", "[].kind", "[].spaces[].id"],
	successCodes: [0],
	async run(_args, ctx) {
		const projects = await allowedProjects(ctx);
		const spaces = await ctx.call("spaces.list", {});
		// An app without spaces.list still lists projects, as the CLI does.
		const file = spaces.ok ? spaces.data as SpacesFile : EMPTY_SPACES_FILE;
		return ok(projects.map((p) => toCliProject(p, file)));
	},
};

const tasksList: ToolDef = {
	name: "tasks_list",
	description: "List a project's tasks, as `dev3 tasks list --json` (live work first, then To Do, then the archive).",
	scope: "read",
	inputSchema: obj({
		project: PROJECT_REF,
		status: { type: "string", enum: ALL_STATUSES },
		open: { type: "boolean", description: "Drop completed and cancelled tasks." },
		label: { type: "string", minLength: 1, maxLength: 64, description: "Label id or prefix." },
		priority: { type: "array", items: { type: "string", enum: ALL_PRIORITIES }, minItems: 1, maxItems: 5 },
		sort: { type: "string", enum: ["priority", "seq"] },
		limit: { type: "integer", minimum: 1 },
		offset: { type: "integer", minimum: 0 },
	}, ["project"]),
	trustedFields: ["schemaVersion", "tasks[].id", "tasks[].seq", "tasks[].projectId", "tasks[].status", "tasks[].customColumnId", "tasks[].priority", "tasks[].taskType", "tasks[].draft", "tasks[].hibernated", "tasks[].runtimeState", "tasks[].updatedAt", "total", "offset", "limit"],
	successCodes: [0],
	async run(args, ctx) {
		const status = str(args.status);
		if (args.open === true && (status === "completed" || status === "cancelled")) usage("open cannot be combined with a completed or cancelled status.");
		const project = await resolveProject(ctx, String(args.project));
		const tasks = await appData<Task[]>(ctx, "tasks.list", { projectId: project.id, ...(status ? { status } : {}) });
		const priorities = Array.isArray(args.priority) ? new Set(args.priority.map((p) => normalizePriority(String(p)) as TaskPriority)) : undefined;
		return ok(buildTasksListJson(tasks, {
			open: args.open === true,
			label: str(args.label),
			priorities,
			sort: args.sort === "seq" ? "seq" : "priority",
			limit: typeof args.limit === "number" ? args.limit : undefined,
			offset: typeof args.offset === "number" ? args.offset : undefined,
		}));
	},
};

const taskShow: ToolDef = {
	name: "task_show",
	description: "One task in full, as `dev3 task show --json` without the worktree path.",
	scope: "read",
	inputSchema: obj({ task: TASK_REF, project: PROJECT_REF, notes: { type: "boolean" }, history: { type: "boolean" } }, ["task"]),
	trustedFields: [
		"schemaVersion", "id", "seq", "projectId", "titleEditedByUser", "status", "customColumnId", "priority", "taskType", "draft",
		"manualCompletion", "labelIds[]", "groupId", "variantIndex", "prNumber", "pullRequests[].number", "pullRequests[].state",
		"prStatus.number", "prStatus.ciStatus", "prStatus.reviewDecision", "prStatus.mergeState", "prStatus.isDraft",
		"prStatus.autoMergeEnabled", "prStatus.unresolvedCount", "prStatus.cachedAt", "hibernated", "keepAlive.enabled",
		"keepAlive.status", "createdAt", "updatedAt", "movedAt", "noteCount", "origin.kind", "origin.taskId", "origin.projectId",
		"origin.automationId", "notes[].id", "notes[].source", "notes[].createdAt", "notes[].updatedAt", "history[].at",
	],
	successCodes: [0],
	async run(args, ctx) {
		const { project, task } = await resolveTask(ctx, String(args.task), str(args.project));
		const shown = await appData<ShownTask>(ctx, "task.show", { taskId: task.id, projectId: project.id });
		const { worktree: _worktree, ...json } = buildTaskShowJson(shown, { notes: args.notes === true, history: args.history === true });
		return ok(json);
	},
};

const eventsList: ToolDef = {
	name: "events_list",
	description: "Board events (notes, moves) since a cursor, as `dev3 events --json`. Follow `cursor` to read on without gaps.",
	scope: "read",
	inputSchema: obj({
		project: { type: "string", minLength: 1, maxLength: 64, description: "Project id/prefix, or \"all\" (only for a token on every project, or the single project it has)." },
		from: { type: "string", minLength: 1, maxLength: 64, description: "An event id, a cursor, an instant, or a duration (2h)." },
		kind: { type: "string", enum: ["note", "move"] },
		limit: { type: "integer", minimum: 1 },
	}),
	trustedFields: [
		"events[].kind", "events[].at", "events[].id", "events[].projectId", "events[].taskId", "events[].seq", "events[].taskStatus",
		"events[].from", "events[].to", "droppedNewer", "olderThanWindow", "matched", "cursor", "from", "movementsEvicted",
	],
	successCodes: [0],
	async run(args, ctx) {
		const rawFrom = str(args.from);
		const cursor = rawFrom ? parseEventCursor(rawFrom) : null;
		const cursorId = !cursor && rawFrom && isEventIdPrefix(rawFrom) ? rawFrom : null;
		if (rawFrom && !cursor && !cursorId) {
			fail(CLI_EXIT_CODE_EVENT_CURSOR_INVALID, "EVENT_CURSOR_INVALID", `Unparseable --from value: ${rawFrom}`);
		}
		const rawProject = str(args.project);
		let projectId: string | undefined;
		if (rawProject && rawProject !== "all") {
			projectId = (await resolveProject(ctx, rawProject)).id;
		} else if (!ctx.token.projects.includes("*")) {
			// A board-wide sweep would count other projects' events; name the one project instead.
			if (ctx.token.projects.length !== 1) usage("This token covers several projects: pass project (one per call).");
			projectId = ctx.token.projects[0];
		}
		const limit = typeof args.limit === "number" ? Math.min(MAX_EVENT_LIMIT, args.limit) : DEFAULT_EVENT_LIMIT;
		const params: Record<string, unknown> = { limit, cursor };
		if (args.kind) params.kind = args.kind;
		if (cursorId) params.cursorId = cursorId;
		if (projectId) params.projectId = projectId;
		return ok(await appData<EventSelection>(ctx, "events.list", params));
	},
};

const approvalsList: ToolDef = {
	name: "approvals_list",
	description: "Pending launch, resume, completion and reset dialogs, as `dev3 approvals list --json`.",
	scope: "read",
	inputSchema: obj({ project: PROJECT_REF }),
	trustedFields: [
		"schemaVersion", "projectId", "requests[].kind", "requests[].requestId", "requests[].taskId", "requests[].projectId",
		"requests[].seqLabel", "requests[].requesterSeq", "requests[].requesterSenderId", "requests[].createdAt",
		"requests[].autoApproveAt", "requests[].heldByUser",
	],
	successCodes: [0],
	async run(args, ctx) {
		const projectId = args.project ? (await resolveProject(ctx, String(args.project))).id : null;
		const { requests } = await appData<{ requests: PendingApprovalSummary[] }>(ctx, "approvals.list");
		return ok(approvalsJson(requests.filter((r) => projectAllowed(ctx.token, r.projectId)), projectId));
	},
};

const uiState: ToolDef = {
	name: "ui_state",
	description: "Is the app in the foreground, how long has the user been idle, and which task is focused (`dev3 ui state --json` without tmux).",
	scope: "read",
	inputSchema: obj({}),
	trustedFields: ["appRunning", "foreground", "activeProjectId", "activeTaskId", "userIdleSeconds"],
	successCodes: [0],
	async run(_args, ctx) {
		const state = await appData<Record<string, unknown>>(ctx, "ui.state", {});
		const visible = typeof state.activeProjectId === "string" && projectAllowed(ctx.token, state.activeProjectId);
		return ok({
			appRunning: state.appRunning,
			foreground: state.foreground,
			activeProjectId: visible ? state.activeProjectId : null,
			activeTaskId: visible ? state.activeTaskId ?? null : null,
			userIdleSeconds: state.userIdleSeconds ?? null,
		});
	},
};

// ── stats (own scope: it exposes spend) ─────────────────────────────────────

function readSince(args: Record<string, unknown>): string | null {
	const raw = str(args.since);
	if (raw === undefined) return null;
	const since = parseSinceValue(raw);
	if (!since) usage(`Unparseable since value: ${raw}. Use a duration (30m, 12h, 7d, 2w), a date (2026-10-01) or a UTC timestamp.`);
	return since;
}

async function allowedTaskIds(ctx: ToolContext): Promise<Set<string>> {
	const ids = new Set<string>();
	for (const project of await allowedProjects(ctx)) {
		for (const task of await appData<Task[]>(ctx, "tasks.list", { projectId: project.id })) ids.add(task.id);
	}
	return ids;
}

const statsGet: ToolDef = {
	name: "stats_get",
	description:
		"`dev3 stats <kind> --json`. usage across every agent needs `since` (the full scan is slow); usage of one task takes `task`.",
	scope: "stats",
	inputSchema: obj({
		kind: { type: "string", enum: ["productivity", "usage", "limits", "memory"] },
		project: PROJECT_REF,
		since: { type: "string", minLength: 1, maxLength: 64 },
		task: TASK_REF,
	}, ["kind"]),
	trustedFields: ["schemaVersion", "generatedAt", "since", "projectId", "hasUnpricedModels"],
	successCodes: [0],
	async run(args, ctx) {
		const kind = String(args.kind);
		if (args.task !== undefined && kind !== "usage") usage("task only applies to kind usage.");
		if (args.project !== undefined && kind !== "productivity" && !(kind === "usage" && args.task !== undefined)) {
			usage("project only applies to kind productivity, or to usage together with task.");
		}
		if (kind === "productivity") {
			const since = readSince(args);
			const projectId = args.project ? (await resolveProject(ctx, String(args.project))).id : null;
			const stats = await appData<ProductivityStats>(ctx, "stats.productivity");
			const visible = { ...stats, events: stats.events.filter((e) => projectAllowed(ctx.token, e.projectId)) };
			return ok(productivityJson(visible, { since, projectId }));
		}
		if (kind === "usage") {
			if (args.task !== undefined) {
				if (args.since !== undefined) usage("since cannot be combined with task: a task's usage is reported whole.");
				const { project, task } = await resolveTask(ctx, String(args.task), str(args.project));
				return ok(taskUsageJson(await appData<TaskUsageReport>(ctx, "stats.taskUsage", { taskId: task.id, projectId: project.id })));
			}
			// ponytail: the all-agent scan held the app's thread for ~80 s before h0x91b/dev-3.0#2150;
			// requiring `since` bounds it. Drop the requirement once that fix is everywhere.
			const since = readSince(args);
			if (!since) usage("usage across every agent needs since (e.g. 7d), or pass task for one task.");
			return ok(usageJson(await appData<AgentUsageReport>(ctx, "stats.usage", { since }), since));
		}
		if (kind === "limits") return ok(limitsJson(await appData<AgentRateLimitsReport>(ctx, "stats.limits")));
		const snapshot = await appData<SystemMemorySnapshot | null>(ctx, "stats.memory");
		if (!snapshot || ctx.token.projects.includes("*")) return ok(memoryJson(snapshot));
		const ids = await allowedTaskIds(ctx);
		return ok(memoryJson({ ...snapshot, topTasks: snapshot.topTasks.filter((t) => t.taskId !== null && ids.has(t.taskId)) }));
	},
};

const statsPrices: ToolDef = {
	name: "stats_prices",
	// `models` is required: without it the app lists every model seen, which runs the
	// same all-agent usage scan `stats_get kind:usage` needs `since` for.
	description: "Token prices for the named models, as `dev3 stats prices --model … --json`.",
	scope: "stats",
	inputSchema: obj({ models: { type: "array", items: { type: "string", minLength: 1, maxLength: 128 }, minItems: 1, maxItems: 50 } }, ["models"]),
	trustedFields: ["schemaVersion", "currency", "unit", "source", "fetchedAt", "models[].priced", "models[].input", "models[].output", "models[].cacheWrite5m", "models[].cacheWrite1h", "models[].cacheRead"],
	successCodes: [0],
	async run(args, ctx) {
		const models = (args.models as string[]).map((m) => m.trim());
		return ok(pricesJson(await appData<PricesWire>(ctx, "stats.prices", { models })));
	},
};

// ── send: messaging as the token's sender ───────────────────────────────────

const messageSend: ToolDef = {
	name: "message_send",
	description:
		"Type a message into a task's main agent as this token's sender, as `dev3 message --as-sender --json`. The agent acts on it with a shell.",
	scope: "send",
	mutating: true,
	inputSchema: obj({
		task: TASK_REF,
		project: PROJECT_REF,
		subject: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_SUBJECT_LENGTH },
		text: { type: "string", minLength: 1, maxLength: MAX_SCHEDULED_MESSAGE_LENGTH },
	}, ["task", "subject", "text"]),
	trustedFields: ["status", "messageId"],
	successCodes: [CLI_EXIT_CODE_SUCCESS, CLI_EXIT_CODE_DELIVERY_UNCONFIRMED],
	async run(args, ctx) {
		const subject = checkMessageSubject(args.subject);
		if (!subject.ok) fail(CLI_EXIT_CODE_MESSAGE_SUBJECT_REQUIRED, "MESSAGE_SUBJECT_REQUIRED", `subject is ${subject.problem}: about six words, ${MAX_MESSAGE_SUBJECT_LENGTH} characters at most.`);
		const { project, task } = await resolveTask(ctx, String(args.task), str(args.project));
		const resp = await ctx.call("message.sendAsSender", {
			taskId: task.id, projectId: project.id, text: String(args.text), subject: subject.subject, asSender: ctx.token.sender,
		});
		if (!resp.ok) {
			const classified = classifyAppError(resp.error, "Failed to send message");
			fail(classified.exitCode, classified.code, classified.message, {}, { status: "not-delivered", messageId: null, error: resp.error ?? "Failed to send message" });
		}
		const data = resp.data as { status?: string; messageId?: string };
		const json = { status: data.status ?? "delivered", messageId: data.messageId ?? null };
		return data.status === "unconfirmed"
			? { exitCode: CLI_EXIT_CODE_DELIVERY_UNCONFIRMED, json, error: { code: "DELIVERY_UNCONFIRMED", message: "Sent, but delivery could not be confirmed. Check before sending it again." } }
			: ok(json);
	},
};

const CLIENT_ID = { type: "string", minLength: 1, maxLength: 128, description: "Your reader id; it holds the inbox lease while you keep polling." } as const;

const inboxWait: ToolDef = {
	name: "inbox_wait",
	description:
		"Replies tasks wrote to this token's sender, as `dev3 sender inbox --json`: answers at once when any are unread, else waits up to waitMs (max 25000). Bodies are untrusted.",
	scope: "send",
	parked: true,
	inputSchema: obj({
		clientId: CLIENT_ID,
		cursor: { type: "string", minLength: 1, maxLength: 256 },
		waitMs: { type: "integer", minimum: 0, maximum: SENDER_WAIT_MAX_MS },
		max: { type: "integer", minimum: 1, maximum: 50 },
	}, ["clientId"]),
	trustedFields: ["items[].id", "items[].at", "items[].fromTaskId", "items[].fromSeq", "items[].fromProjectId", "items[].inReplyTo", "cursor", "more", "pruned[].day", "pruned[].unacked", "pruned[].at"],
	successCodes: [0],
	async run(args, ctx) {
		const result = await appData<SenderWaitResult>(ctx, "sender.wait", {
			senderId: ctx.token.sender,
			clientId: String(args.clientId),
			cursor: str(args.cursor) ?? null,
			timeoutMs: typeof args.waitMs === "number" ? args.waitMs : 0,
			...(typeof args.max === "number" ? { max: args.max } : {}),
		});
		return ok({ ...result, items: result.items.map(({ spillPath: _spill, ...item }) => item) });
	},
};

const inboxAck: ToolDef = {
	name: "inbox_ack",
	description: "Acknowledge inbox items, as `dev3 sender ack --json`. Idempotent; needs the lease inbox_wait took for clientId.",
	scope: "send",
	mutating: true,
	inputSchema: obj({
		clientId: CLIENT_ID,
		ids: { type: "array", items: { type: "string", minLength: 1, maxLength: 64 }, minItems: 1, maxItems: 50 },
	}, ["clientId", "ids"]),
	trustedFields: ["acked[]", "unknown[]"],
	successCodes: [0],
	async run(args, ctx) {
		const result = await appData<{ acked: string[]; unknown: string[] }>(ctx, "sender.ack", {
			senderId: ctx.token.sender, clientId: String(args.clientId), ids: args.ids,
		});
		return ok({ acked: result.acked, unknown: result.unknown });
	},
};

// ── write: To Do tasks and priority ─────────────────────────────────────────

const taskCreate: ToolDef = {
	name: "task_create",
	// No pr/branch: resolving them runs gh and fetches fork code on the host, which a
	// network token must not trigger.
	description: "Create a task in To Do, as `dev3 task create --json`. It does not start; task_start asks the user.",
	scope: "write",
	mutating: true,
	inputSchema: obj({
		project: PROJECT_REF,
		title: { type: "string", minLength: 1, maxLength: 200 },
		description: { type: "string", maxLength: MAX_SCHEDULED_MESSAGE_LENGTH },
		type: { type: "string", enum: ["coordinator", "pr-review", "board-cleanup", "standard"] },
		priority: { type: "string", enum: ALL_PRIORITIES },
	}, ["project", "title"]),
	trustedFields: MUTATION_TRUSTED,
	successCodes: [0],
	async run(args, ctx) {
		const project = await resolveProject(ctx, String(args.project));
		const title = String(args.title).trim();
		if (!title) usage("title cannot be blank.");
		const task = await appData<Task>(ctx, "task.create", {
			projectId: project.id,
			title,
			...(str(args.description)?.trim() ? { description: String(args.description) } : {}),
			...(args.type && args.type !== "standard" ? { taskType: args.type } : {}),
			...(args.priority ? { priority: args.priority } : {}),
		});
		return ok(taskMutationJson(task));
	},
};

const taskSetPriority: ToolDef = {
	name: "task_set_priority",
	description: "Set one task's priority (P0 highest … P4), as `dev3 task update --priority --json`.",
	scope: "write",
	mutating: true,
	inputSchema: obj({ task: TASK_REF, project: PROJECT_REF, priority: { type: "string", enum: ALL_PRIORITIES } }, ["task", "priority"]),
	trustedFields: [...MUTATION_TRUSTED, "titlePreserved", "roleDelivery"],
	successCodes: [0],
	async run(args, ctx) {
		const { project, task } = await resolveTask(ctx, String(args.task), str(args.project));
		const result = await appData<Task | { task: Task; titlePreserved?: boolean; roleDelivery?: string }>(ctx, "task.update", {
			taskId: task.id, projectId: project.id, priority: args.priority,
		});
		const updated = "task" in result ? result.task : result;
		const extra: { titlePreserved?: boolean; roleDelivery?: string } = "task" in result ? result : {};
		return ok({ ...taskMutationJson(updated), titlePreserved: Boolean(extra.titlePreserved), roleDelivery: extra.roleDelivery ?? null });
	},
};

// ── start: launches and resumes, always through the approval dialog ─────────

/** How long one call waits on the dialog before answering "still pending" (exit 25). */
export const MCP_APPROVAL_WAIT_MS = 20_000;

async function pendingRequest(ctx: ToolContext, taskId: string): Promise<{ requests: PendingApprovalSummary[]; mine: PendingApprovalSummary | null }> {
	const { requests } = await appData<{ requests: PendingApprovalSummary[] }>(ctx, "approvals.list");
	return { requests, mine: requests.find((r) => r.kind === "launch" && r.taskId === taskId) ?? null };
}

function pendingOutcome(mine: PendingApprovalSummary | null): ToolOutcome {
	return {
		exitCode: CLI_EXIT_CODE_APPROVAL_STILL_PENDING,
		json: { pending: true, requestId: mine?.requestId ?? null, autoApproveAt: mine?.autoApproveAt ?? null },
		error: { code: "APPROVAL_STILL_PENDING", message: "The approval dialog is still open. Call again to keep waiting; it never opens a second dialog.", retryAfterS: 2 },
	};
}

async function refuseTooManyPending(ctx: ToolContext): Promise<void> {
	const { requests } = await pendingRequest(ctx, "");
	const open = requests.filter((r) => r.requesterSenderId === ctx.token.sender).length;
	if (open >= MCP_LIMITS.pendingDialogsPerSender) {
		fail(CLI_EXIT_CODE_COMMAND_FAILED, "TOO_MANY_PENDING", `This sender already has ${open} approval dialogs open; wait for the user to answer them.`);
	}
}

/** Race a detached call against the wait; the call itself keeps running and is joined by the next one. */
async function raceApproval<T>(promise: Promise<T>, waitMs: number): Promise<{ settled: true; value: T } | { settled: false }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<{ settled: false }>((resolve) => {
		timer = setTimeout(() => resolve({ settled: false }), waitMs);
	});
	try {
		return await Promise.race([promise.then((value) => ({ settled: true as const, value })), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

interface StartEntry {
	sender: string;
	promise: Promise<CliResponse>;
	settled?: { at: number; resp: CliResponse };
}

/**
 * One launch per task, whoever re-asks: a re-call joins the running request, and
 * an answer given in the last 15 minutes is handed back instead of asking again.
 * The handler never runs twice for one answer.
 */
const starts = new Map<string, StartEntry>();
const START_OUTCOME_TTL_MS = 15 * 60_000;

export function _resetMcpStartsForTests(): void {
	starts.clear();
}

function startOutcome(resp: CliResponse): ToolOutcome {
	if (!resp.ok) {
		const classified = classifyAppError(resp.error, "Failed to start the task");
		return { exitCode: classified.exitCode, error: { code: classified.code, message: classified.message } };
	}
	const data = resp.data as { approved?: boolean } & Partial<Task>;
	if (data.approved === false) {
		return { exitCode: CLI_EXIT_CODE_LAUNCH_DECLINED, json: { schemaVersion: 1, approved: false }, error: { code: "LAUNCH_DECLINED", message: "The user declined the launch request." } };
	}
	if (data.approved === true) return ok({ schemaVersion: 1, ...data });
	// The task was already in the target column: a same-status move is a no-op.
	return ok({ schemaVersion: 1, alreadyActive: true, task: { id: data.id, seq: data.seq, status: data.status } });
}

const taskStart: ToolDef = {
	name: "task_start",
	description:
		"Ask the user to start a To Do task (target: in-progress) through the approval dialog. Answers exit 25 while the dialog is open — call again to keep waiting; it never opens a second one. Exit 10 if declined.",
	scope: "start",
	parked: true,
	mutating: true,
	inputSchema: obj({ task: TASK_REF, project: PROJECT_REF }, ["task"]),
	trustedFields: ["schemaVersion", "approved", "seq", "launched[].variantIndex", "alreadyActive", "task.id", "task.seq", "task.status", "pending", "requestId", "autoApproveAt"],
	successCodes: [0],
	async run(args, ctx) {
		const { project, task } = await resolveTask(ctx, String(args.task), str(args.project));
		const now = Date.now();
		let entry = starts.get(task.id);
		if (entry?.settled && (now - entry.settled.at > START_OUTCOME_TTL_MS || entry.sender !== ctx.token.sender)) {
			starts.delete(task.id);
			entry = undefined;
		}
		if (entry && !entry.settled && entry.sender !== ctx.token.sender) {
			fail(CLI_EXIT_CODE_COMMAND_FAILED, "COMMAND_FAILED", "Another sender's launch request is pending for this task — wait for its answer.");
		}
		if (entry?.settled) return startOutcome(entry.settled.resp);
		if (!entry) {
			if (ACTIVE_STATUSES.includes(task.status)) {
				return ok({ schemaVersion: 1, alreadyActive: true, task: { id: task.id, seq: task.seq, status: task.status } });
			}
			await refuseTooManyPending(ctx);
			const created: StartEntry = {
				sender: ctx.token.sender,
				// Detached from the HTTP request on purpose: a dropped client must not cancel a launch the user may approve.
				promise: ctx.call("task.moveAsSender", {
					taskId: task.id,
					projectId: project.id,
					newStatus: "in-progress",
					asSender: ctx.token.sender,
					viaTokenId: ctx.token.id,
					...(ctx.token.autoApprove ? {} : { interactiveOnly: true }),
				}),
			};
			// Only an answer is remembered; a failure (a draft, a missing window) is retried fresh next time.
			const forget = () => {
				if (starts.get(task.id) === created) starts.delete(task.id);
			};
			created.promise.then((resp) => {
				if (resp.ok && typeof (resp.data as { approved?: unknown })?.approved === "boolean") created.settled = { at: Date.now(), resp };
				else forget();
			}, forget);
			starts.set(task.id, created);
			entry = created;
		}
		const raced = await raceApproval(entry.promise, ctx.approvalWaitMs ?? MCP_APPROVAL_WAIT_MS);
		if (raced.settled) return startOutcome(raced.value);
		return pendingOutcome((await pendingRequest(ctx, task.id)).mine);
	},
};

const RESUME_OUTCOME_EXIT: Record<CliResumeOutcome["outcome"], number> = {
	resumed: CLI_EXIT_CODE_SUCCESS,
	"already-running": CLI_EXIT_CODE_RESUME_ALREADY_RUNNING,
	unavailable: CLI_EXIT_CODE_RESUME_UNAVAILABLE,
	declined: CLI_EXIT_CODE_LAUNCH_DECLINED,
};

const agentResume: ToolDef = {
	name: "agent_resume",
	description:
		"Ask the user to resume a task's saved agent session through the approval dialog, as `dev3 agent resume --json`. Exit 25 while the dialog is open (call again), 31 if already running.",
	scope: "start",
	parked: true,
	mutating: true,
	inputSchema: obj({ task: TASK_REF, project: PROJECT_REF }, ["task"]),
	trustedFields: ["outcome", "taskId", "seq", "backend", "reason", "stale", "resume.seq", "resume.backend", "resume.woke", "pending", "requestId", "autoApproveAt"],
	successCodes: [CLI_EXIT_CODE_SUCCESS, CLI_EXIT_CODE_RESUME_ALREADY_RUNNING],
	async run(args, ctx) {
		const { project, task } = await resolveTask(ctx, String(args.task), str(args.project));
		const { mine } = await pendingRequest(ctx, task.id);
		if (!mine) await refuseTooManyPending(ctx);
		// cli-agent-resume joins a re-ask from the same sender onto the open request,
		// so the call can be detached here and simply re-issued.
		const promise = ctx.call("agent.resumeAsSender", {
			taskId: task.id,
			projectId: project.id,
			asSender: ctx.token.sender,
			viaTokenId: ctx.token.id,
			...(ctx.token.autoApprove ? {} : { interactiveOnly: true }),
		});
		const raced = await raceApproval(promise, ctx.approvalWaitMs ?? MCP_APPROVAL_WAIT_MS);
		if (!raced.settled) return pendingOutcome((await pendingRequest(ctx, task.id)).mine);
		const resp = raced.value;
		if (!resp.ok) {
			const classified = classifyAppError(resp.error, "Failed to resume");
			return { exitCode: classified.exitCode, error: { code: classified.code, message: classified.message } };
		}
		const result = resp.data as CliResumeOutcome;
		const exitCode = RESUME_OUTCOME_EXIT[result.outcome];
		const codes: Record<number, string> = { 31: "RESUME_ALREADY_RUNNING", 32: "RESUME_UNAVAILABLE", 10: "LAUNCH_DECLINED" };
		return exitCode === 0 ? ok(result) : { exitCode, json: result, error: { code: codes[exitCode], message: "message" in result ? result.message : result.outcome } };
	},
};

// ── the table ───────────────────────────────────────────────────────────────

const whoami: ToolDef = {
	name: "whoami",
	description: "Who this token speaks as, what it may do, and on which projects.",
	scope: null,
	inputSchema: obj({}),
	trustedFields: ["schemaVersion", "tokenId", "sender.id", "scopes[]", "projects[]", "expiresAt", "server.version", "server.protocol", "tools[]", "approvals.autoApprove", "approvals.interactive", "limits"],
	successCodes: [0],
	async run(_args, ctx) {
		const { token } = ctx;
		return ok({
			schemaVersion: 1,
			tokenId: token.id,
			sender: { id: token.sender, label: ctx.senderLabel },
			scopes: token.scopes,
			projects: token.projects,
			expiresAt: token.expiresAt,
			server: { version: MCP_SERVER_INFO.version, protocol: MCP_PROTOCOL_VERSION },
			tools: MCP_TOOLS.filter((t) => toolAllowed(t, token)).map((t) => t.name),
			approvals: { autoApprove: token.autoApprove, interactive: !token.autoApprove },
			limits: MCP_LIMITS,
		});
	},
};

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SERVER_INFO = { name: "dev3", version: "1" };

/** The listener's limits, reported by `whoami` and enforced in `server.ts`. */
export const MCP_LIMITS = {
	bodyBytes: 1024 * 1024,
	globalInFlight: 16,
	perTokenInFlight: 8,
	perTokenParked: 4,
	callsPerMinute: 600,
	mutatingCallsPerMinute: 30,
	pendingDialogsPerSender: 3,
} as const;

export const MCP_TOOLS: ToolDef[] = [
	whoami,
	projectsList,
	tasksList,
	taskShow,
	eventsList,
	approvalsList,
	uiState,
	statsGet,
	statsPrices,
	messageSend,
	inboxWait,
	inboxAck,
	taskCreate,
	taskSetPriority,
	taskStart,
	agentResume,
];

export function toolAllowed(tool: ToolDef, token: McpTokenRecord): boolean {
	return tool.scope === null || token.scopes.includes(tool.scope);
}

export function findTool(name: string): ToolDef | undefined {
	return MCP_TOOLS.find((t) => t.name === name);
}

/** Validate, check the scope, run, and turn every failure into a CLI-shaped outcome. */
export async function runTool(tool: ToolDef, args: unknown, ctx: ToolContext): Promise<ToolOutcome> {
	if (!toolAllowed(tool, ctx.token)) {
		return { exitCode: CLI_EXIT_CODE_COMMAND_FAILED, error: { code: "SCOPE_DENIED", message: `${tool.name} needs the "${tool.scope}" scope, which this token does not have.` } };
	}
	const problem = validate(tool.inputSchema, args ?? {});
	if (problem) return { exitCode: CLI_EXIT_CODE_USAGE_ERROR, error: { code: "USAGE", message: problem } };
	try {
		return await tool.run((args ?? {}) as Record<string, unknown>, ctx);
	} catch (err) {
		if (err instanceof ToolFailure) return err.outcome;
		throw err;
	}
}
