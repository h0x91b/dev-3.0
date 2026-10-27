/**
 * The address of ONE agent process inside a task: `dev3 pane list` prints it,
 * `dev3 message --agent` takes it, and a reply command carries the sender's.
 * Opaque on purpose, because what it packs is the #1927 author binding (pane,
 * conversation, pane generation, `pid@start`), and a raw pane id survives the
 * agent it named. Lossless: decoding gives back the exact binding, so every
 * identity check runs on the same values #2062 compared.
 *
 * Bytes: version, then each field as a tag plus its compact form — a `%N` /
 * `pane-N` pane id as N, a lowercase UUID as its 16 bytes, `pid@<ps lstart>` as
 * pid and calendar seconds, `pid@linux:<boot id>:<tick>` as pid, boot UUID and
 * tick — or, for any value that form would not rebuild exactly, the original
 * UTF-8 string. base64url of that.
 */

import type { ScheduledMessageAuthor } from "./types";
import { base64UrlToBytes, bytesToBase64Url } from "./base64url";

const VERSION = 2;

/** Handles #2062 wrote (`a1.` + base64url JSON): refused, so callers can say why. */
export const LEGACY_AGENT_HANDLE_PREFIX = "a1.";

const RAW = 0;
const COMPACT = 1;
const NATIVE = 2;
const NONE = 3;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LINUX_SIGNATURE_RE = /^([1-9]\d{0,9})@linux:([0-9a-f-]{36}):(0|[1-9]\d{0,14})$/;
const LSTART_RE = /^([1-9]\d{0,9})@([A-Z][a-z]{2}) ([A-Z][a-z]{2}) ([1-9]\d?) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

class Writer {
	bytes: number[] = [];
	varint(value: number): void {
		let rest = value;
		while (rest >= 0x80) {
			this.bytes.push((rest % 0x80) | 0x80);
			rest = Math.floor(rest / 0x80);
		}
		this.bytes.push(rest);
	}
	raw(value: string): void {
		const utf8 = new TextEncoder().encode(value);
		this.bytes.push(RAW);
		this.varint(utf8.length);
		this.bytes.push(...utf8);
	}
}

class Reader {
	private at = 0;
	constructor(private readonly bytes: Uint8Array) {}
	get done(): boolean {
		return this.at === this.bytes.length;
	}
	byte(): number {
		if (this.at >= this.bytes.length) throw new Error("truncated");
		return this.bytes[this.at++]!;
	}
	varint(): number {
		let value = 0;
		for (let scale = 1; scale <= 2 ** 49; scale *= 0x80) {
			const byte = this.byte();
			value += (byte & 0x7f) * scale;
			if (byte < 0x80) return value;
		}
		throw new Error("varint too long");
	}
	take(length: number): Uint8Array {
		if (this.at + length > this.bytes.length) throw new Error("truncated");
		return this.bytes.slice(this.at, (this.at += length));
	}
	utf8(): string {
		return new TextDecoder("utf-8", { fatal: true }).decode(this.take(this.varint()));
	}
}

function writePane(out: Writer, paneId: string): void {
	const tmux = /^%(0|[1-9]\d{0,9})$/.exec(paneId);
	const native = /^pane-([1-9]\d{0,9})$/.exec(paneId);
	if (tmux) out.bytes.push(COMPACT);
	else if (native) out.bytes.push(NATIVE);
	else return out.raw(paneId);
	out.varint(Number((tmux ?? native)![1]));
}

function readPane(input: Reader): string {
	const tag = input.byte();
	if (tag === RAW) return input.utf8();
	if (tag === COMPACT) return `%${input.varint()}`;
	if (tag === NATIVE) return `pane-${input.varint()}`;
	throw new Error("bad pane tag");
}

function writeUuid(out: Writer, uuid: string): void {
	const hex = uuid.replace(/-/g, "");
	for (let i = 0; i < 32; i += 2) out.bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
}

function readUuid(input: Reader): string {
	const hex = [...input.take(16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function writeId(out: Writer, id: string | null): void {
	if (id === null) return void out.bytes.push(NONE);
	if (!UUID_RE.test(id)) return out.raw(id);
	out.bytes.push(COMPACT);
	writeUuid(out, id);
}

function readId(input: Reader): string | null {
	const tag = input.byte();
	if (tag === NONE) return null;
	if (tag === RAW) return input.utf8();
	if (tag !== COMPACT) throw new Error("bad id tag");
	return readUuid(input);
}

/**
 * The `ps lstart` text as naive calendar seconds (read and written in UTC, so
 * the machine's timezone and DST never enter), and back. Only for text this
 * rebuilds character for character; anything else travels as the raw string.
 */
function lstartSeconds(weekday: string, month: string, day: string, hh: string, mm: string, ss: string, year: string): number | null {
	const ms = Date.UTC(Number(year), MONTHS.indexOf(month), Number(day), Number(hh), Number(mm), Number(ss));
	return Number.isFinite(ms) && ms >= 0 && formatLstart(ms / 1000) === `${weekday} ${month} ${day} ${hh}:${mm}:${ss} ${year}` ? ms / 1000 : null;
}

function formatLstart(seconds: number): string {
	const d = new Date(seconds * 1000);
	const two = (n: number) => String(n).padStart(2, "0");
	return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

function writeProcess(out: Writer, signature: string): void {
	const linux = LINUX_SIGNATURE_RE.exec(signature);
	if (linux && UUID_RE.test(linux[2]!)) {
		out.bytes.push(NATIVE);
		out.varint(Number(linux[1]));
		writeUuid(out, linux[2]!);
		return out.varint(Number(linux[3]));
	}
	const match = LSTART_RE.exec(signature);
	const seconds = match ? lstartSeconds(match[2]!, match[3]!, match[4]!, match[5]!, match[6]!, match[7]!, match[8]!) : null;
	if (!match || seconds === null) return out.raw(signature);
	out.bytes.push(COMPACT);
	out.varint(Number(match[1]));
	out.varint(seconds);
}

function readProcess(input: Reader): string {
	const tag = input.byte();
	if (tag === RAW) return input.utf8();
	if (tag === NATIVE) {
		const pid = input.varint();
		const boot = readUuid(input);
		return `${pid}@linux:${boot}:${input.varint()}`;
	}
	if (tag !== COMPACT) throw new Error("bad process tag");
	const pid = input.varint();
	return `${pid}@${formatLstart(input.varint())}`;
}

export function encodeAgentHandle(author: ScheduledMessageAuthor): string {
	const out = new Writer();
	out.bytes.push(VERSION);
	writePane(out, author.paneId);
	writeId(out, author.sessionId);
	writeId(out, author.paneToken);
	writeProcess(out, author.agentProcess);
	return bytesToBase64Url(Uint8Array.from(out.bytes));
}

/** The identity a handle names, or null for anything this version did not write. */
export function decodeAgentHandle(handle: string): ScheduledMessageAuthor | null {
	const value = handle.trim();
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
	let author: ScheduledMessageAuthor;
	try {
		const input = new Reader(base64UrlToBytes(value));
		if (input.byte() !== VERSION) return null;
		const paneId = readPane(input);
		const sessionId = readId(input);
		const paneToken = readId(input);
		const agentProcess = readProcess(input);
		if (!input.done || paneToken === null) return null;
		author = { paneId, sessionId, paneToken, agentProcess };
	} catch {
		return null;
	}
	if (!author.paneId || author.sessionId === "" || !author.paneToken) return null;
	if (!/^[1-9]\d*@\S/.test(author.agentProcess)) return null;
	// One spelling per binding: a re-encoding that differs means bytes this version never writes.
	return encodeAgentHandle(author) === value ? author : null;
}
