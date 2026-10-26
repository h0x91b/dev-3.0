/**
 * The reply inbox of an external sender: what tasks wrote back with
 * `dev3 message --to-sender <id>`.
 *
 * Layout: `~/.dev3.0/external-senders/<slug>/YYYY-MM-DD.jsonl` (0600, append-only)
 * plus `bodies/<item-id>.md` for a body too large for one row. A new directory —
 * nothing existing is renamed or migrated, and an older app never opens it.
 *
 * The FILE is the source of truth, never memory: `~/.dev3.0` is shared by every
 * installed instance, so a reply may be appended by one instance while the sender
 * waits on another. Waits re-read the files (a 1 s poll plus `fs.watch`), and acks
 * are folded from the file on every read. Only the reader lease lives in memory.
 *
 * Rows follow the message log's rule: one row is one `appendFileSync` under
 * `AGENT_MESSAGE_LOG_MAX_ROW_BYTES`, so two processes can never tear each other's
 * lines. A torn line is skipped.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { AGENT_MESSAGE_LOG_MAX_ROW_BYTES } from "../shared/agent-message-log";
import {
	parseSenderInboxRow,
	SENDER_INBOX_BUSY_ERROR,
	SENDER_INBOX_MAX_UNACKED,
	SENDER_INBOX_RETENTION_DAYS,
	SENDER_LEASE_GRACE_MS,
	SENDER_WAIT_MAX_ITEMS,
	SENDER_WAIT_MAX_MS,
	type SenderInboxItem,
	type SenderInboxRow,
	type SenderPrunedNotice,
	type SenderWaitResult,
	senderInboxSlug,
} from "../shared/external-senders";
import { DEV3_HOME } from "./paths";
import { createLogger } from "./logger";

const log = createLogger("external-sender-inbox");

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}):(\d+)$/;
const POLL_MS = 1_000;

export function senderInboxDir(senderId: string): string {
	return `${DEV3_HOME}/external-senders/${senderInboxSlug(senderId)}`;
}

function dayStamp(at: Date): string {
	return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

function dayFiles(dir: string): string[] {
	try {
		return readdirSync(dir).filter((name) => DAY_FILE_RE.test(name)).sort();
	} catch {
		return [];
	}
}

/** Where an item ends in its day-file; orders items across files. */
interface Position {
	day: string;
	end: number;
}

function after(a: Position, b: Position | null): boolean {
	if (!b) return true;
	return a.day > b.day || (a.day === b.day && a.end > b.end);
}

function parseCursor(cursor: unknown): Position | null {
	if (cursor === null || cursor === undefined || cursor === "") return null;
	const match = CURSOR_RE.exec(String(cursor));
	if (!match) throw new Error(`Invalid inbox cursor "${String(cursor)}". Pass back the cursor a previous wait returned, or none.`);
	return { day: match[1], end: Number(match[2]) };
}

const formatCursor = (pos: Position): string => `${pos.day}:${pos.end}`;

interface ScannedItem {
	item: SenderInboxItem;
	pos: Position;
}

interface ScannedPruned {
	notice: SenderPrunedNotice;
	pos: Position;
}

/** Every unacknowledged item in append order, plus the prune notices. Acks are folded from the file itself. */
function scanInbox(dir: string, files: string[] = dayFiles(dir)): { items: ScannedItem[]; pruned: ScannedPruned[] } {
	const open = new Map<string, ScannedItem>();
	const pruned: ScannedPruned[] = [];
	for (const name of files) {
		let content: Buffer;
		try {
			content = readFileSync(`${dir}/${name}`);
		} catch {
			continue;
		}
		const day = name.slice(0, -".jsonl".length);
		let start = 0;
		while (start < content.length) {
			let nl = content.indexOf(0x0a, start);
			if (nl === -1) nl = content.length;
			const row = parseSenderInboxRow(content.subarray(start, nl).toString("utf8"));
			start = nl + 1;
			if (!row) continue;
			if (row.kind === "item") {
				const { v: _v, kind: _kind, ...item } = row;
				open.set(item.id, { item, pos: { day, end: nl } });
			} else if (row.kind === "ack") {
				for (const id of row.ids) open.delete(id);
			} else {
				pruned.push({ notice: { day: row.day, unacked: row.unacked, at: row.at }, pos: { day, end: nl } });
			}
		}
	}
	return { items: [...open.values()], pruned };
}

const scanUnacked = (dir: string, files?: string[]): ScannedItem[] => scanInbox(dir, files).items;

/**
 * Never into a day-file older than the newest one: a reader's cursor may already
 * sit in it, and a row behind the cursor would never be served. An append racing
 * midnight from another instance, or a clock that moved back, lands in the newest.
 */
function appendRow(dir: string, row: SenderInboxRow, now: Date): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const files = dayFiles(dir);
	const newest = files[files.length - 1]?.slice(0, -".jsonl".length);
	const day = newest && newest > dayStamp(now) ? newest : dayStamp(now);
	appendFileSync(`${dir}/${day}.jsonl`, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

const fitsOneRow = (row: SenderInboxRow): boolean =>
	new TextEncoder().encode(`${JSON.stringify(row)}\n`).length <= AGENT_MESSAGE_LOG_MAX_ROW_BYTES;

/** In-process wake-up for waits parked on a sender; other instances are caught by the poll. */
const localWaiters = new Map<string, Set<() => void>>();

function wakeLocalWaiters(senderId: string): void {
	for (const wake of localWaiters.get(senderId) ?? []) wake();
}

/**
 * Append one reply. Refused once the sender has {@link SENDER_INBOX_MAX_UNACKED}
 * unacknowledged items — a sender that stopped reading must not grow a file without
 * bound. The cap is read from the file, so it is soft across instances.
 */
export function postToSenderInbox(
	senderId: string,
	input: Omit<SenderInboxItem, "id" | "at" | "spillPath">,
	now: Date = new Date(),
): SenderInboxItem {
	const dir = senderInboxDir(senderId);
	pruneSenderInbox(senderId, now);
	const unacked = scanUnacked(dir).length;
	if (unacked >= SENDER_INBOX_MAX_UNACKED) {
		throw new Error(
			`The inbox of external sender "${senderId}" is full: ${unacked} unacknowledged replies (max ${SENDER_INBOX_MAX_UNACKED}). ` +
				"Nothing was written. The sender has to acknowledge what it read before it can receive more.",
		);
	}
	const item: SenderInboxItem = { id: randomUUID(), at: now.toISOString(), ...input };
	let row: SenderInboxRow = { v: 1, kind: "item", ...item };
	if (!fitsOneRow(row)) {
		const spillPath = `${dir}/bodies/${item.id}.md`;
		mkdirSync(`${dir}/bodies`, { recursive: true, mode: 0o700 });
		writeFileSync(spillPath, item.body, { encoding: "utf8", mode: 0o600, flag: "wx" });
		item.spillPath = spillPath;
		item.body = `This reply is ${new TextEncoder().encode(input.body).length} bytes and was written to a file: ${spillPath}`;
		row = { v: 1, kind: "item", ...item };
	}
	try {
		appendRow(dir, row, now);
	} catch (err) {
		// A body no row points at would never be swept by the prune.
		if (item.spillPath) unlinkQuietly(item.spillPath);
		throw err;
	}
	wakeLocalWaiters(senderId);
	return item;
}

function unlinkQuietly(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Already gone.
	}
}

/** A spilled body is handed back whole; a body file already gone keeps the pointer. */
function withFullBody(item: SenderInboxItem): SenderInboxItem {
	if (!item.spillPath) return item;
	try {
		return { ...item, body: readFileSync(item.spillPath, "utf8") };
	} catch {
		return item;
	}
}

/**
 * The page after `cursor`. Prune notices travel with it, so unread replies the
 * retention window deleted never read as silence; each is reported once, because
 * the cursor moves past it.
 */
function collect(dir: string, cursor: Position | null, max: number): SenderWaitResult {
	const scanned = scanInbox(dir);
	const fresh = scanned.items.filter((s) => after(s.pos, cursor));
	const page = fresh.slice(0, max);
	const more = fresh.length > page.length;
	const lastItem = page.length > 0 ? page[page.length - 1].pos : null;
	// When the page is cut short, a notice past it waits for the next page.
	const notices = scanned.pruned.filter((p) => p.notice.unacked > 0 && after(p.pos, cursor) && (!more || !after(p.pos, lastItem)));
	let last = cursor;
	for (const pos of [lastItem, notices[notices.length - 1]?.pos ?? null]) if (pos && after(pos, last)) last = pos;
	return {
		items: page.map((s) => withFullBody(s.item)),
		cursor: last ? formatCursor(last) : null,
		more,
		...(notices.length > 0 ? { pruned: notices.map((p) => p.notice) } : {}),
	};
}

/** Names and sizes of the day-files: changes whenever any instance appends. */
function signature(dir: string): string {
	return dayFiles(dir).map((name) => {
		try {
			return `${name}:${statSync(`${dir}/${name}`).size}`;
		} catch {
			return name;
		}
	}).join("|");
}

/** Resolve on the first of: a local post, an `fs.watch` event, the poll tick, abort. */
function nextChange(dir: string, senderId: string, ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		let watcher: ReturnType<typeof watch> | null = null;
		const waiters = localWaiters.get(senderId) ?? new Set<() => void>();
		localWaiters.set(senderId, waiters);
		const done = () => {
			clearTimeout(timer);
			watcher?.close();
			waiters.delete(done);
			if (waiters.size === 0) localWaiters.delete(senderId);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		waiters.add(done);
		signal?.addEventListener("abort", done);
		try {
			watcher = watch(dir, done);
		} catch {
			// No watch on this platform or dir — the poll still catches it.
		}
	});
}

/**
 * The unacknowledged items after `cursor`. Answers at once when there are any;
 * otherwise parks until one is appended (by any instance), the timeout passes, or
 * the client's connection closes.
 */
export async function waitForSenderItems(
	senderId: string,
	opts: { cursor?: unknown; timeoutMs?: number; max?: number; signal?: AbortSignal },
): Promise<SenderWaitResult> {
	const dir = senderInboxDir(senderId);
	const cursor = parseCursor(opts.cursor);
	const max = Math.max(1, Math.min(SENDER_WAIT_MAX_ITEMS, Math.floor(opts.max ?? SENDER_WAIT_MAX_ITEMS)));
	const timeoutMs = Math.max(0, Math.min(SENDER_WAIT_MAX_MS, opts.timeoutMs ?? 0));
	const deadline = Date.now() + timeoutMs;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	let seen = "";
	for (;;) {
		const current = signature(dir);
		if (current !== seen) {
			seen = current;
			const result = collect(dir, cursor, max);
			// Without a cursor a notice can never be moved past, so on its own it must
			// not end the wait — that would turn every cursorless --wait into a busy loop.
			if (result.items.length > 0 || (cursor && result.pruned)) return result;
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0 || opts.signal?.aborted) {
			// A cursorless wait that parked its full time gets the notices it held back,
			// with a cursor that moves past them.
			// An item another instance appended since the last scan comes back too,
			// rather than being skipped by the cursor.
			const last = collect(dir, cursor, max);
			return last.items.length > 0 || last.pruned ? last : { items: [], cursor: cursor ? formatCursor(cursor) : null, more: false };
		}
		await nextChange(dir, senderId, Math.min(remaining, POLL_MS), opts.signal);
	}
}

/**
 * Acknowledge items by id (or a unique ≥8-char prefix). Idempotent: ids that are
 * already acknowledged or never existed are reported, not refused.
 */
export function ackSenderItems(
	senderId: string,
	clientId: string,
	ids: string[],
	now: Date = new Date(),
): { acked: string[]; unknown: string[] } {
	const dir = senderInboxDir(senderId);
	const open = scanUnacked(dir).map((s) => s.item.id);
	const acked = new Set<string>();
	const unknown: string[] = [];
	for (const ref of ids) {
		const matches = open.filter((id) => id === ref || (ref.length >= 8 && id.startsWith(ref)));
		if (matches.length === 1) acked.add(matches[0]);
		else if (matches.length > 1) throw new Error(`Inbox item id ${ref} is ambiguous — pass more characters.`);
		else unknown.push(ref);
	}
	if (acked.size > 0) appendRow(dir, { v: 1, kind: "ack", at: now.toISOString(), ids: [...acked], clientId }, now);
	return { acked: [...acked], unknown };
}

let lastPrunedDay = new Map<string, string>();

/**
 * Delete day-files past the retention window — after first writing a `pruned`
 * row naming the day and how many unread items it took, so trimmed history never
 * reads as silence. Once per sender per day; never throws.
 */
export function pruneSenderInbox(senderId: string, now: Date = new Date()): void {
	const today = dayStamp(now);
	if (lastPrunedDay.get(senderId) === today) return;
	lastPrunedDay.set(senderId, today);
	const dir = senderInboxDir(senderId);
	const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const cutoff = dayStamp(new Date(midnight - (SENDER_INBOX_RETENTION_DAYS - 1) * DAY_MS));
	for (const name of dayFiles(dir)) {
		const day = name.slice(0, -".jsonl".length);
		if (day >= cutoff) continue;
		try {
			const scanned = scanInbox(dir);
			const unacked = scanned.items.filter((s) => s.pos.day === day).length;
			// Every body the file points at goes with it, acknowledged or not.
			const bodies = readFileSync(`${dir}/${name}`, "utf8").split("\n").map(parseSenderInboxRow)
				.flatMap((row) => (row?.kind === "item" && row.spillPath ? [row.spillPath] : []));
			// A crash (or another instance) between the row and the unlink already wrote one.
			if (!scanned.pruned.some((p) => p.notice.day === day)) {
				appendRow(dir, { v: 1, kind: "pruned", at: now.toISOString(), day, unacked }, now);
			}
			unlinkSync(`${dir}/${name}`);
			for (const body of bodies) unlinkQuietly(body);
		} catch (err) {
			// Another instance may have pruned it first.
			log.warn("Could not prune a sender inbox day-file", { senderId, day, error: String(err) });
		}
	}
	// Bodies a crash left without a row (or without their day-file) age out by mtime.
	const bodiesDir = `${dir}/bodies`;
	const oldest = midnight - SENDER_INBOX_RETENTION_DAYS * DAY_MS;
	try {
		for (const name of readdirSync(bodiesDir)) {
			try {
				if (statSync(`${bodiesDir}/${name}`).mtimeMs < oldest) unlinkQuietly(`${bodiesDir}/${name}`);
			} catch {
				// Gone between the listing and the stat.
			}
		}
	} catch {
		// No bodies directory.
	}
}

/** Test seam: forget which senders were pruned today. */
export function resetSenderInboxPruneState(): void {
	lastPrunedDay = new Map();
}

/**
 * One reader at a time per sender. Only a wait with a `clientId` takes the lease;
 * the holder keeps it while parked and for {@link SENDER_LEASE_GRACE_MS} after,
 * enough to ack and wait again. A second client is refused, never handed over,
 * unless a human passes `takeOver`.
 *
 * ponytail: in-memory per app instance — two instances could each grant one. Move
 * it into a lock file if senders ever talk to two instances at once.
 */
interface Lease {
	clientId: string;
	parked: number;
	expiresAt: number;
}

const leases = new Map<string, Lease>();

function liveHolder(senderId: string, now: number): Lease | null {
	const lease = leases.get(senderId);
	return lease && (lease.parked > 0 || lease.expiresAt > now) ? lease : null;
}

function busyError(senderId: string, holder: Lease): Error {
	return new Error(
		`${SENDER_INBOX_BUSY_ERROR}: client "${holder.clientId}" is reading the inbox of "${senderId}". ` +
			`Its lease lapses ${SENDER_LEASE_GRACE_MS / 1000}s after its last wait. ` +
			"A person who knows that reader is gone can pass --take-over.",
	);
}

/** Take or keep the lease for a wait; returns the release to call when the wait ends. */
export function acquireSenderLease(senderId: string, clientId: string, takeOver = false): () => void {
	const now = Date.now();
	const holder = liveHolder(senderId, now);
	if (holder && holder.clientId !== clientId && !takeOver) throw busyError(senderId, holder);
	const lease: Lease = holder && holder.clientId === clientId ? holder : { clientId, parked: 0, expiresAt: 0 };
	lease.parked += 1;
	leases.set(senderId, lease);
	return () => {
		lease.parked -= 1;
		if (lease.parked === 0) lease.expiresAt = Date.now() + SENDER_LEASE_GRACE_MS;
	};
}

/** An ack needs the lease: refused while another client holds it, else taken. */
export function requireSenderLease(senderId: string, clientId: string): void {
	const now = Date.now();
	const holder = liveHolder(senderId, now);
	if (holder && holder.clientId !== clientId) throw busyError(senderId, holder);
	if (holder) {
		holder.expiresAt = Math.max(holder.expiresAt, now + SENDER_LEASE_GRACE_MS);
		return;
	}
	leases.set(senderId, { clientId, parked: 0, expiresAt: now + SENDER_LEASE_GRACE_MS });
}

/** Test seam. */
export function resetSenderLeases(): void {
	leases.clear();
}
