/**
 * Append-only, per-project log of every message delivered into a task's agent.
 *
 * Layout: `~/.dev3.0/data/<projectSlug>/messages/YYYY-MM-DD.jsonl` — a NEW
 * directory beside the existing `tasks.json`, which is the only shape the on-disk
 * invariants in AGENTS.md allow. Nothing existing is renamed, nothing is migrated,
 * and an older app version simply never opens this directory.
 *
 * Why one file per day rather than the single `messages.jsonl` the request named:
 * retention has to be real, and the only way to trim a single append-only file is
 * to rewrite it — which stops being append-only and loses rows when two app
 * instances (the installed app plus a dev build) do it at the same moment.
 * Deleting a whole expired day-file needs no rewrite and no rename.
 *
 * Concurrency: one row is one `appendFileSync` on a file opened `O_APPEND`, so the
 * kernel serialises the seek-and-write and two processes can never overwrite each
 * other's bytes. Rows are capped at `AGENT_MESSAGE_LOG_MAX_ROW_BYTES` so a single
 * `write()` always carries the whole line — a buffer big enough to be split could
 * tear one row across another. A reader that meets a torn line skips it.
 *
 * Privacy: bodies land unencrypted, exactly as the agents wrote them, including
 * paths and anything pasted by mistake. The file is `0600`, same as the terminal
 * stream taps, and nothing is filtered — a redacted traffic log would not answer
 * the question it exists for.
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import type { Project } from "../shared/types";
import {
	AGENT_MESSAGE_LOG_RETENTION_DAYS,
	type AgentMessageLogInput,
	type AgentMessageLogPage,
	type AgentMessageLogRow,
	parseAgentMessageLogRow,
	serializeAgentMessageLogRow,
} from "../shared/agent-message-log";
import { DEV3_HOME } from "./paths";
import { projectSlug } from "./git";
import { createLogger } from "./logger";

const log = createLogger("agent-message-log");

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

/** Local-day stamp, matching the diagnostic log's convention. */
function dayStamp(at: Date): string {
	return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

/** The per-project directory holding the day-files. */
export function messageLogDir(project: Project): string {
	return `${DEV3_HOME}/data/${projectSlug(project.path)}/messages`;
}

function dayFile(project: Project, at: Date): string {
	return `${messageLogDir(project)}/${dayStamp(at)}.jsonl`;
}

function parseDay(fileName: string): number | null {
	const match = DAY_FILE_RE.exec(fileName);
	if (!match) return null;
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const date = new Date(year, month - 1, day);
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
	return date.getTime();
}

/**
 * Delete day-files outside the retention window. Best-effort and silent: a
 * concurrent writer or a permission change must never break message delivery.
 * Returns how many files went.
 */
export function pruneAgentMessageLog(project: Project, now: Date = new Date()): number {
	const dir = messageLogDir(project);
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const cutoff = today - (AGENT_MESSAGE_LOG_RETENTION_DAYS - 1) * DAY_MS;
	let removed = 0;
	try {
		for (const name of readdirSync(dir)) {
			const day = parseDay(name);
			if (day === null || day >= cutoff) continue;
			try {
				unlinkSync(`${dir}/${name}`);
				removed += 1;
			} catch {
				// Another instance may have removed it already.
			}
		}
	} catch {
		// No directory yet, or unreadable — nothing to prune.
	}
	return removed;
}

let lastPrunedDay = new Map<string, string>();

function pruneIfNeeded(project: Project, now: Date): void {
	const today = dayStamp(now);
	if (lastPrunedDay.get(project.id) === today) return;
	lastPrunedDay.set(project.id, today);
	pruneAgentMessageLog(project, now);
}

/** Test seam: forget which projects were pruned today. */
export function resetAgentMessageLogPruneState(): void {
	lastPrunedDay = new Map();
}

/**
 * Append one row. Never throws: a message that was delivered must not be reported
 * as failed because a log write lost a race with a disk error.
 */
export function appendAgentMessageLog(project: Project, input: AgentMessageLogInput, now: Date = new Date()): void {
	const line = serializeAgentMessageLogRow(input);
	const file = dayFile(project, now);
	try {
		mkdirSync(messageLogDir(project), { recursive: true });
		appendFileSync(file, line, { mode: 0o600 });
	} catch (err) {
		log.warn("Failed to append to the message log", { projectId: project.id, error: String(err) });
		return;
	}
	pruneIfNeeded(project, now);
}

/**
 * Read recent history, newest first. Torn and unparseable lines are skipped —
 * losing one row beats losing the day it lives in.
 */
export function readAgentMessageLog(project: Project, limit = 500): AgentMessageLogPage {
	const dir = messageLogDir(project);
	let days: string[];
	try {
		days = readdirSync(dir).filter((name) => parseDay(name) !== null).sort();
	} catch {
		return { rows: [], oldestDay: null, retentionDays: AGENT_MESSAGE_LOG_RETENTION_DAYS, hasMore: false };
	}
	const oldestDay = days[0] ? days[0].slice(0, -".jsonl".length) : null;
	const rows: AgentMessageLogRow[] = [];
	let hasMore = false;
	for (const name of [...days].reverse()) {
		if (rows.length >= limit) {
			hasMore = true;
			break;
		}
		let content: string;
		try {
			content = readFileSync(`${dir}/${name}`, "utf8");
		} catch {
			continue;
		}
		const dayRows: AgentMessageLogRow[] = [];
		for (const line of content.split("\n")) {
			const row = parseAgentMessageLogRow(line);
			if (row) dayRows.push(row);
		}
		dayRows.reverse();
		for (const row of dayRows) {
			if (rows.length >= limit) {
				hasMore = true;
				break;
			}
			rows.push(row);
		}
	}
	return { rows, oldestDay, retentionDays: AGENT_MESSAGE_LOG_RETENTION_DAYS, hasMore };
}
