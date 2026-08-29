import {
	DEFAULT_EVENT_LIMIT,
	DEFAULT_EVENT_WINDOW_MS,
	EVENT_CURSOR_UNRESOLVED_PREFIX,
	MAX_EVENT_LIMIT,
	isEventIdPrefix,
	parseEventCursor,
	type BoardEvent,
	type EventSelection,
} from "../../shared/board-events";
import { CLI_EXIT_CODE_EVENT_CURSOR_INVALID } from "../../shared/cli-exit-codes";
import { sendRequest } from "../socket-client";
import { printTable, exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";

/** v1 emits notes only; the flag exists so a v2 kind is a filter, not a reshape. */
const VALID_KINDS = ["all", "note"] as const;

const TITLE_WIDTH = 34;
const TEXT_WIDTH = 72;

function formatWhen(iso: string): string {
	return new Date(iso).toLocaleDateString("en-GB", {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function truncate(text: string, maxLen: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length <= maxLen) return oneLine;
	return oneLine.slice(0, maxLen - 1) + "…";
}

function windowHours(windowMs: number): string {
	const hours = Math.round(windowMs / (60 * 60 * 1000));
	return `${hours}h`;
}

function renderTable(events: BoardEvent[], multiProject: boolean): void {
	const headers = ["KIND", "WHEN", "ID", "SEQ", "STATUS", ...(multiProject ? ["PROJECT"] : []), "TASK", "WHAT"];
	const rows = events.map((e) => [
		e.kind,
		formatWhen(e.at),
		e.id.slice(0, 8),
		e.seq === null ? "-" : String(e.seq),
		e.taskStatus,
		...(multiProject ? [truncate(e.projectName, 18)] : []),
		truncate(e.taskTitle, TITLE_WIDTH),
		truncate(e.text, TEXT_WIDTH),
	]);
	printTable(headers, rows);
}

function renderFooter(
	sel: EventSelection,
	opts: { asked: string | null; resolved: string | null; limit: number; windowMs: number },
): void {
	const out = (line: string) => process.stdout.write(`${line}\n`);
	out("");

	if (opts.asked) {
		out(`${sel.events.length} event${sel.events.length === 1 ? "" : "s"} since ${opts.asked}.`);
	} else {
		out(
			`${sel.events.length} event${sel.events.length === 1 ? "" : "s"} in the last ${windowHours(opts.windowMs)}` +
			" — this is a WINDOW, not a position (no --from given).",
		);
		if (sel.olderThanWindow > 0) {
			out(
				`Older than the window: ${sel.olderThanWindow} event${sel.olderThanWindow === 1 ? "" : "s"} NOT shown.` +
				" Pass --from <id|cursor> to read from a position instead.",
			);
		} else {
			out("Older than the window: 0 events. Nothing was cut off.");
		}
	}

	if (sel.droppedNewer > 0) {
		out(
			`Capped at --limit ${opts.limit}: ${sel.droppedNewer} NEWER event${sel.droppedNewer === 1 ? "" : "s"} not shown.` +
			" The oldest were kept, so continuing from the cursor below leaves no hole.",
		);
	}

	// On a quiet sweep, echo the RESOLVED instant rather than what was typed: a
	// caller that stores `2h` verbatim would keep re-reading a moving window.
	const cursor = sel.cursor ?? opts.resolved;
	if (cursor) {
		out(`Cursor: ${cursor}`);
		out(`Next:   dev3 events --from ${cursor}`);
	} else {
		out("Cursor: none yet — the board has no events in this window.");
	}
}

async function listEvents(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["from", "limit", "project", "kind", "json"]);
	if (args.positional.length > 0) {
		exitUsage(
			`dev3 events takes no subcommand or positional argument (got: ${args.positional[0]}).\n` +
			"Usage: dev3 events [--from <id|cursor|instant|duration>] [--limit <n>] [--project <ref>|all] [--json]",
		);
	}

	const rawFrom = args.flags.from;
	if (rawFrom === "true") {
		exitUsage("--from needs a value. Usage: dev3 events --from <id|cursor|instant|duration>");
	}
	// Never degraded into a default window: silently answering "the last day"
	// skips everything older and looks like success.
	const cursor = rawFrom ? parseEventCursor(rawFrom) : null;
	const cursorId = !cursor && rawFrom && isEventIdPrefix(rawFrom) ? rawFrom : null;
	if (rawFrom && !cursor && !cursorId) {
		exitError(
			`Unparseable --from value: ${rawFrom}`,
			"Four shapes are accepted:\n" +
			"  an event id  dev3 events --from 8eb2da3d                  (the ID column of a previous run)\n" +
			"  a cursor     dev3 events --from 2026-08-29T10:12:03.114   (its `Cursor:` line)\n" +
			"  an instant   dev3 events --from 2026-08-01                (a deliberately wider sweep)\n" +
			"  a duration   dev3 events --from 2h                        (s, m, h, d, w)\n" +
			"Lost your cursor? Run `dev3 events` with no --from; it reports how much it cut off.",
			CLI_EXIT_CODE_EVENT_CURSOR_INVALID,
		);
	}

	const kind = args.flags.kind ?? "all";
	if (!(VALID_KINDS as readonly string[]).includes(kind)) {
		exitUsage(`Invalid --kind: ${kind}. Valid: ${VALID_KINDS.join(", ")}`);
	}

	let limit = DEFAULT_EVENT_LIMIT;
	if (args.flags.limit !== undefined) {
		const parsed = Number(args.flags.limit);
		if (!Number.isFinite(parsed) || parsed < 1) {
			exitUsage(`Invalid --limit: ${args.flags.limit}. Expected a positive integer.`);
		}
		limit = Math.min(MAX_EVENT_LIMIT, Math.floor(parsed));
	}

	// `--project all` is the explicit way to sweep every board; the default is the
	// project the caller is standing in, which is what a coordinator wants.
	const allProjects = args.flags.project === "all";
	const projectId = allProjects ? undefined : resolveProjectId(args.flags.project, context);

	const params: Record<string, unknown> = { limit, cursor };
	if (cursorId) params.cursorId = cursorId;
	if (projectId) params.projectId = projectId;

	const resp = await sendRequest(socketPath, "events.list", params);
	if (!resp.ok) {
		// An id that points at nothing is a cursor problem, not a failed read:
		// answering "no events since then" would read as a quiet board.
		const marker = resp.error?.indexOf(EVENT_CURSOR_UNRESOLVED_PREFIX) ?? -1;
		if (marker !== -1 && resp.error) {
			const [head, ...rest] = resp.error.slice(marker + EVENT_CURSOR_UNRESOLVED_PREFIX.length).split("\n");
			exitError(head, rest.join("\n") || undefined, CLI_EXIT_CODE_EVENT_CURSOR_INVALID);
		}
		exitError(resp.error || "Failed to read events");
	}

	const selection = resp.data as EventSelection;

	if (args.flags.json === "true") {
		process.stdout.write(JSON.stringify(selection, null, 2) + "\n");
		return;
	}

	if (selection.events.length === 0) {
		process.stdout.write("No events\n");
	} else {
		renderTable(selection.events, allProjects || !projectId);
	}
	renderFooter(selection, {
		asked: rawFrom ?? null,
		resolved: selection.from ?? (cursor ? cursor.replace(/Z$/, "") : null),
		limit,
		windowMs: DEFAULT_EVENT_WINDOW_MS,
	});
}

export async function handleEvents(
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	return listEvents(args, socketPath, context);
}
