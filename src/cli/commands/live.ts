import type { LiveArtifact } from "../../shared/types";
import type { LiveDoc, LiveEvent } from "../../shared/live-artifact";
import { LIVE_READ_ONLY_PREFIX, LIVE_REV_CONFLICT_PREFIX } from "../../shared/live-artifact";
import { CLI_EXIT_CODE_LIVE_READ_ONLY, CLI_EXIT_CODE_LIVE_REV_CONFLICT } from "../../shared/cli-exit-codes";
import type { ParsedArgs } from "../args";
import { expandShortId, resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";
import { exitError, exitUsage, printTable } from "../output";
import { sendRequest } from "../socket-client";
import { readStdin } from "../stdin";
import { resolveArtifactSource } from "./show-artifact";

const USAGE = `Usage:
  dev3 live publish <report-dir | file.html> [asset...] [--title "..."]   Create or replace the task's live page (no versions)
  dev3 live adopt <artifact-id> [--version N]       Make an existing artifact (version) the live page
  dev3 live url                                      Browser URL of the live page (loopback; starts the server)
  dev3 live status [--json]                          Page, collections, unhandled events, size
  dev3 live list [<collection>]                      Collections with counts, or one collection's documents (JSON)
  dev3 live get <collection> <id>                    One document (JSON)
  dev3 live set <collection> <id> <json|@file|->     Replace a document         [--if-rev N]
  dev3 live patch <collection> <id> <json|@file|->   JSON Merge Patch into it   [--if-rev N]
  dev3 live delete <collection> <id>                 Remove a document          [--if-rev N]
  dev3 live events [--unhandled] [--since <id>]      What the user did on the page (JSON)
  dev3 live ack <event-id...> | --all                Mark events handled
  dev3 live clear [--data]                           Remove the live page; --data also wipes its store
All take [--task <id>] [--project <id>]; inside a worktree the task is detected.`;

const TARGET_FLAGS = ["task", "task-id", "project"];

function target(args: ParsedArgs, context: CliContext | null): Record<string, unknown> {
	const rawTaskId = args.flags.task || args.flags["task-id"] || context?.taskId;
	if (!rawTaskId) exitUsage("No task in context. Run inside a worktree or pass --task <id>.");
	const params: Record<string, unknown> = { taskId: expandShortId(rawTaskId, context) };
	const projectId = resolveProjectId(args.flags.project, context);
	if (projectId) params.projectId = projectId;
	return params;
}

async function request<T>(socketPath: string, method: string, params: Record<string, unknown>): Promise<T> {
	const response = await sendRequest(socketPath, method, params);
	if (response.ok) return response.data as T;
	const error = response.error || `${method} failed`;
	if (error.startsWith(LIVE_REV_CONFLICT_PREFIX)) exitError(error.slice(LIVE_REV_CONFLICT_PREFIX.length), undefined, CLI_EXIT_CODE_LIVE_REV_CONFLICT);
	if (error.startsWith(LIVE_READ_ONLY_PREFIX)) exitError(error.slice(LIVE_READ_ONLY_PREFIX.length), undefined, CLI_EXIT_CODE_LIVE_READ_ONLY);
	exitError(error);
}

function printJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function docRef(args: ParsedArgs, verb: string): { collection: string; id: string } {
	const [collection, id] = args.positional;
	if (!collection || !id) exitUsage(`Usage: dev3 live ${verb} <collection> <id>${verb === "delete" ? "" : " <json|@file|->"}`);
	return { collection, id };
}

async function jsonValue(args: ParsedArgs, verb: string): Promise<unknown> {
	const raw = args.positional[2];
	if (raw === undefined) exitUsage(`Usage: dev3 live ${verb} <collection> <id> <json|@file|->`);
	const text = raw === "-" ? await readStdin() : raw;
	try {
		return JSON.parse(text);
	} catch (error) {
		exitUsage(`Value is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function withRev(args: ParsedArgs, params: Record<string, unknown>): Record<string, unknown> {
	if (args.flags["if-rev"] === undefined) return params;
	const rev = Number(args.flags["if-rev"]);
	if (!Number.isInteger(rev) || rev < 0) exitUsage(`Invalid --if-rev "${args.flags["if-rev"]}": expected a non-negative integer`);
	return { ...params, ifRev: rev };
}

function describePage(live: LiveArtifact): string {
	return `"${live.page.title}" (page rev ${live.pageRev})`;
}

export async function handleLive(subcommand: string | undefined, args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	switch (subcommand) {
		case "publish": {
			rejectUnknownFlags(args, [...TARGET_FLAGS, "title"]);
			const [html, ...assets] = args.positional;
			if (!html) exitUsage('Usage: dev3 live publish <report-dir | file.html> [asset...] [--title "..."]');
			const { htmlPath, assetPaths } = resolveArtifactSource(html, assets);
			const params: Record<string, unknown> = { ...target(args, context), htmlPath, assetPaths };
			if (args.flags.title?.trim()) params.title = args.flags.title.trim();
			const result = await request<{ taskId: string; liveArtifact: LiveArtifact }>(socketPath, "live.publish", params);
			process.stdout.write(`Live page ${describePage(result.liveArtifact)} published to task ${result.taskId.slice(0, 8)}.\n`);
			return;
		}
		case "adopt": {
			rejectUnknownFlags(args, [...TARGET_FLAGS, "version"]);
			const artifact = args.positional[0];
			if (!artifact) exitUsage("Usage: dev3 live adopt <artifact-id> [--version N]");
			const params: Record<string, unknown> = { ...target(args, context), artifact };
			if (args.flags.version !== undefined) params.version = Number(args.flags.version);
			const result = await request<{ adoptedFrom: { id: string; version: number }; liveArtifact: LiveArtifact }>(socketPath, "live.adopt", params);
			process.stdout.write(`Artifact ${result.adoptedFrom.id.slice(0, 8)} v${result.adoptedFrom.version} is now the live page ${describePage(result.liveArtifact)}.\n`);
			return;
		}
		case "url": {
			rejectUnknownFlags(args, TARGET_FLAGS);
			const result = await request<{ url: string; hasPage: boolean }>(socketPath, "live.url", target(args, context));
			process.stdout.write(`${result.url}\n`);
			if (!result.hasPage) process.stderr.write("note: no live page yet — publish one with dev3 live publish <dir>\n");
			return;
		}
		case "status": {
			rejectUnknownFlags(args, [...TARGET_FLAGS, "json"]);
			const status = await request<{
				readOnly: boolean;
				liveArtifact: LiveArtifact | null;
				rev: number;
				collections: Record<string, number>;
				events: { total: number; unhandled: number };
				bytes: number;
			}>(socketPath, "live.status", target(args, context));
			if (args.flags.json === "true") return printJson(status);
			const names = Object.entries(status.collections);
			process.stdout.write(
				[
					`Page:        ${status.liveArtifact ? describePage(status.liveArtifact) : "none (dev3 live publish <dir>)"}${status.readOnly ? " — read-only" : ""}`,
					`Store:       rev ${status.rev}, ${status.bytes} bytes`,
					`Collections: ${names.length ? names.map(([name, count]) => `${name} (${count})`).join(", ") : "none"}`,
					`Events:      ${status.events.unhandled} unhandled of ${status.events.total}`,
				].join("\n") + "\n",
			);
			return;
		}
		case "list": {
			rejectUnknownFlags(args, TARGET_FLAGS);
			const params = { ...target(args, context), collection: args.positional[0] };
			const result = await request<{ collections?: Record<string, number>; docs?: LiveDoc[] }>(socketPath, "live.list", params);
			if (result.docs) return printJson(result.docs);
			const rows = Object.entries(result.collections ?? {}).map(([name, count]) => [name, String(count)]);
			if (rows.length === 0) process.stdout.write("No collections\n");
			else printTable(["COLLECTION", "DOCS"], rows);
			return;
		}
		case "get": {
			rejectUnknownFlags(args, TARGET_FLAGS);
			printJson(await request<LiveDoc>(socketPath, "live.get", { ...target(args, context), ...docRef(args, "get") }));
			return;
		}
		case "set":
		case "patch": {
			rejectUnknownFlags(args, [...TARGET_FLAGS, "if-rev"]);
			const ref = docRef(args, subcommand);
			const value = await jsonValue(args, subcommand);
			const params = withRev(args, { ...target(args, context), ...ref, [subcommand === "set" ? "data" : "patch"]: value });
			const change = await request<{ rev: number }>(socketPath, `live.${subcommand}`, params);
			process.stdout.write(`${subcommand === "set" ? "Set" : "Patched"} ${ref.collection}/${ref.id} (rev ${change.rev}).\n`);
			return;
		}
		case "delete": {
			rejectUnknownFlags(args, [...TARGET_FLAGS, "if-rev"]);
			const ref = docRef(args, "delete");
			const result = await request<{ deleted: boolean }>(socketPath, "live.delete", withRev(args, { ...target(args, context), ...ref }));
			process.stdout.write(result.deleted ? `Deleted ${ref.collection}/${ref.id}.\n` : `No document ${ref.collection}/${ref.id}; nothing deleted.\n`);
			return;
		}
		case "events": {
			rejectUnknownFlags(args, [...TARGET_FLAGS, "unhandled", "since"]);
			const params: Record<string, unknown> = { ...target(args, context), unhandled: args.flags.unhandled === "true" };
			if (args.flags.since !== undefined) params.since = Number(args.flags.since);
			printJson(await request<LiveEvent[]>(socketPath, "live.events", params));
			return;
		}
		case "ack": {
			rejectUnknownFlags(args, [...TARGET_FLAGS, "all"]);
			const all = args.flags.all === "true";
			const ids = args.positional.map(Number);
			if (!all && (ids.length === 0 || ids.some((id) => !Number.isInteger(id)))) exitUsage("Usage: dev3 live ack <event-id...> | --all");
			const result = await request<{ acked: number }>(socketPath, "live.ack", { ...target(args, context), ...(all ? { all: true } : { ids }) });
			process.stdout.write(`Marked ${result.acked} event(s) handled.\n`);
			return;
		}
		case "clear": {
			rejectUnknownFlags(args, [...TARGET_FLAGS, "data"]);
			const result = await request<{ clearedData: boolean }>(socketPath, "live.clear", { ...target(args, context), data: args.flags.data === "true" });
			process.stdout.write(result.clearedData ? "Live page removed and its data wiped.\n" : "Live page removed; its data is kept.\n");
			return;
		}
		default:
			exitUsage(subcommand ? `Unknown live subcommand: ${subcommand}\n${USAGE}` : USAGE);
	}
}
