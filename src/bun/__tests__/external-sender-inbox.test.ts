import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";

const home = vi.hoisted(() => require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/dev3-inbox-`) as string);
vi.mock("../paths", () => ({ DEV3_HOME: home }));
vi.mock("../logger", () => ({
	createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../cli-socket/task-resolution", () => ({
	resolveTaskAcrossProjects: vi.fn(async (id: string) =>
		id === "worker-task" ? { project: { id: "proj-1" }, task: { id: "worker-task", seq: 26, title: "Worker", projectId: "proj-1" } } : null),
}));

import {
	SENDER_INBOX_BUSY_ERROR,
	SENDER_INBOX_MAX_UNACKED,
	SENDER_LEASE_GRACE_MS,
	type SenderInboxItem,
	parseSenderInboxRow,
} from "../../shared/external-senders";
import {
	ackSenderItems,
	acquireSenderLease,
	postToSenderInbox,
	pruneSenderInbox,
	requireSenderLease,
	resetSenderInboxPruneState,
	resetSenderLeases,
	senderInboxDir,
	waitForSenderItems,
} from "../external-sender-inbox";
import { externalSenderHandlers } from "../cli-socket/external-sender-commands";

const SENDER = "openclaw:home:main";
const dir = () => senderInboxDir(SENDER);

function reply(body = "done", extra: Partial<SenderInboxItem> = {}) {
	return { fromTaskId: "worker-task", fromSeq: 26, fromProjectId: "proj-1", subject: "result", body, ...extra };
}

function stamp(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function rowsOf(file: string) {
	return readFileSync(file, "utf8").split("\n").map(parseSenderInboxRow).filter(Boolean);
}

beforeEach(() => {
	rmSync(`${home}/external-senders`, { recursive: true, force: true });
	writeFileSync(`${home}/external-senders.json`, JSON.stringify({ senders: { [SENDER]: { label: "OpenClaw" } } }));
	resetSenderInboxPruneState();
	resetSenderLeases();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("post and wait", () => {
	it("stores a reply under the colon-free slug, 0600, and hands it straight back", async () => {
		const item = postToSenderInbox(SENDER, reply("hello", { inReplyTo: "m-1" }));
		expect(dir()).toMatch(/external-senders\/openclaw__home__main$/);
		const file = `${dir()}/${stamp(new Date())}.jsonl`;
		expect(statSync(file).mode & 0o777).toBe(0o600);
		const result = await waitForSenderItems(SENDER, { timeoutMs: 5_000 });
		expect(result.items).toEqual([expect.objectContaining({ id: item.id, body: "hello", inReplyTo: "m-1" })]);
		expect(result.cursor).toMatch(/^\d{4}-\d{2}-\d{2}:\d+$/);
		expect(result.more).toBe(false);
	});

	it("skips what the cursor already covered, while a null cursor sees every unacked item again", async () => {
		postToSenderInbox(SENDER, reply("one"));
		const first = await waitForSenderItems(SENDER, {});
		postToSenderInbox(SENDER, reply("two"));
		const next = await waitForSenderItems(SENDER, { cursor: first.cursor });
		expect(next.items.map((i) => i.body)).toEqual(["two"]);
		const again = await waitForSenderItems(SENDER, { cursor: null });
		expect(again.items.map((i) => i.body)).toEqual(["one", "two"]);
	});

	it("pages at 50 and says more are waiting", async () => {
		for (let i = 0; i < 52; i++) postToSenderInbox(SENDER, reply(`r${i}`));
		const page = await waitForSenderItems(SENDER, { max: 500 });
		expect(page.items).toHaveLength(50);
		expect(page.more).toBe(true);
		const rest = await waitForSenderItems(SENDER, { cursor: page.cursor });
		expect(rest.items.map((i) => i.body)).toEqual(["r50", "r51"]);
		expect(rest.more).toBe(false);
	});

	it("rejects a cursor it never handed out", async () => {
		await expect(waitForSenderItems(SENDER, { cursor: "garbage" })).rejects.toThrow(/Invalid inbox cursor/);
	});
});

describe("parking", () => {
	it("times out empty, keeping the cursor it was given", async () => {
		postToSenderInbox(SENDER, reply());
		const { cursor } = await waitForSenderItems(SENDER, {});
		const started = Date.now();
		const result = await waitForSenderItems(SENDER, { cursor, timeoutMs: 300 });
		expect(result).toEqual({ items: [], cursor, more: false });
		expect(Date.now() - started).toBeGreaterThanOrEqual(250);
	});

	it("resolves as soon as this instance appends", async () => {
		const parked = waitForSenderItems(SENDER, { timeoutMs: 10_000 });
		await new Promise((r) => setTimeout(r, 50));
		const started = Date.now();
		postToSenderInbox(SENDER, reply("live"));
		const result = await parked;
		expect(result.items.map((i) => i.body)).toEqual(["live"]);
		expect(Date.now() - started).toBeLessThan(500);
	});

	it("resolves when ANOTHER instance appends to the shared file", async () => {
		const parked = waitForSenderItems(SENDER, { timeoutMs: 10_000 });
		await new Promise((r) => setTimeout(r, 50));
		// A second app version writes the row itself; no in-process wake-up exists for it.
		const row = { v: 1, kind: "item", id: "other-instance-1", at: new Date().toISOString(), ...reply("from elsewhere") };
		mkdirSync(dir(), { recursive: true });
		appendFileSync(`${dir()}/${stamp(new Date())}.jsonl`, `${JSON.stringify(row)}\n`);
		const result = await parked;
		expect(result.items.map((i) => i.id)).toEqual(["other-instance-1"]);
	});

	it("stops parking when the client's connection closes", async () => {
		const abort = new AbortController();
		const started = Date.now();
		const parked = waitForSenderItems(SENDER, { timeoutMs: 20_000, signal: abort.signal });
		setTimeout(() => abort.abort(), 50);
		expect((await parked).items).toEqual([]);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("never parks past 25 s, whatever the caller asks", async () => {
		vi.useFakeTimers();
		const parked = waitForSenderItems(SENDER, { timeoutMs: 600_000 });
		await vi.advanceTimersByTimeAsync(25_500);
		expect((await parked).items).toEqual([]);
	});
});

describe("ack", () => {
	it("folds acks out of later reads, is idempotent, and takes an 8-char prefix", async () => {
		const a = postToSenderInbox(SENDER, reply("a"));
		const b = postToSenderInbox(SENDER, reply("b"));
		expect(ackSenderItems(SENDER, "c1", [a.id.slice(0, 8)])).toEqual({ acked: [a.id], unknown: [] });
		expect(ackSenderItems(SENDER, "c1", [a.id, "never-existed"])).toEqual({ acked: [], unknown: [a.id, "never-existed"] });
		const result = await waitForSenderItems(SENDER, {});
		expect(result.items.map((i) => i.id)).toEqual([b.id]);
		const ackRows = rowsOf(`${dir()}/${stamp(new Date())}.jsonl`).filter((r) => r!.kind === "ack");
		expect(ackRows).toHaveLength(1);
	});
});

describe("limits", () => {
	it("refuses a post once 500 replies are unacknowledged, and writes nothing", () => {
		mkdirSync(dir(), { recursive: true });
		const file = `${dir()}/${stamp(new Date())}.jsonl`;
		const lines = Array.from({ length: SENDER_INBOX_MAX_UNACKED }, (_, i) =>
			JSON.stringify({ v: 1, kind: "item", id: `i-${i}`, at: "", ...reply() })).join("\n");
		writeFileSync(file, `${lines}\n`);
		const before = readFileSync(file, "utf8");
		expect(() => postToSenderInbox(SENDER, reply())).toThrow(/full: 500 unacknowledged/);
		expect(readFileSync(file, "utf8")).toBe(before);
		ackSenderItems(SENDER, "c1", ["i-0"]);
		expect(() => postToSenderInbox(SENDER, reply())).not.toThrow();
	});

	it("spills a body too large for one row into a 0600 side file and serves it whole", async () => {
		const body = "x".repeat(20_000);
		const item = postToSenderInbox(SENDER, reply(body));
		expect(item.spillPath).toBe(`${dir()}/bodies/${item.id}.md`);
		expect(statSync(item.spillPath!).mode & 0o777).toBe(0o600);
		const line = readFileSync(`${dir()}/${stamp(new Date())}.jsonl`, "utf8");
		expect(line.length).toBeLessThan(8_192);
		const result = await waitForSenderItems(SENDER, {});
		expect(result.items[0]!.body).toBe(body);
	});

	it("reports a prune notice once, then moves the cursor past it", async () => {
		mkdirSync(dir(), { recursive: true });
		const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
		writeFileSync(`${dir()}/${stamp(old)}.jsonl`, `${JSON.stringify({ v: 1, kind: "item", id: "ancient", at: old.toISOString(), ...reply() })}\n`);
		pruneSenderInbox(SENDER);
		const first = await waitForSenderItems(SENDER, { timeoutMs: 300 });
		expect(first.items).toEqual([]);
		expect(first.pruned).toEqual([expect.objectContaining({ day: stamp(old), unacked: 1 })]);
		const next = await waitForSenderItems(SENDER, { cursor: first.cursor });
		expect(next).toEqual({ items: [], cursor: first.cursor, more: false });
	});

	it("keeps a cursorless wait parked when only a prune notice is waiting — no busy loop", async () => {
		mkdirSync(dir(), { recursive: true });
		const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
		writeFileSync(`${dir()}/${stamp(old)}.jsonl`, `${JSON.stringify({ v: 1, kind: "item", id: "ancient", at: old.toISOString(), ...reply() })}\n`);
		pruneSenderInbox(SENDER);
		const started = Date.now();
		const result = await waitForSenderItems(SENDER, { timeoutMs: 400 });
		expect(Date.now() - started).toBeGreaterThanOrEqual(350);
		expect(result.items).toEqual([]);
		expect(result.cursor).not.toBeNull();
		// With items, the notice still rides along.
		postToSenderInbox(SENDER, reply("fresh"));
		expect((await waitForSenderItems(SENDER, {})).pruned).toEqual([expect.objectContaining({ day: stamp(old) })]);
	});

	it("writes one prune notice per day even when the day-file outlived a first prune", () => {
		mkdirSync(dir(), { recursive: true });
		const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
		const oldFile = `${dir()}/${stamp(old)}.jsonl`;
		const content = `${JSON.stringify({ v: 1, kind: "item", id: "ancient", at: old.toISOString(), ...reply() })}\n`;
		writeFileSync(oldFile, content);
		pruneSenderInbox(SENDER);
		// A crash between the notice and the unlink leaves the file behind.
		writeFileSync(oldFile, content);
		resetSenderInboxPruneState();
		pruneSenderInbox(SENDER);
		const notices = rowsOf(`${dir()}/${stamp(new Date())}.jsonl`).filter((r) => r!.kind === "pruned");
		expect(notices).toHaveLength(1);
		expect(existsSync(oldFile)).toBe(false);
	});

	it("sweeps body files a crash left without a row once they age past retention", () => {
		mkdirSync(`${dir()}/bodies`, { recursive: true });
		const orphan = `${dir()}/bodies/orphan.md`;
		const fresh = `${dir()}/bodies/fresh.md`;
		writeFileSync(orphan, "x");
		writeFileSync(fresh, "y");
		const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
		utimesSync(orphan, old, old);
		pruneSenderInbox(SENDER);
		expect(existsSync(orphan)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
	});

	it("removes the spilled body when the row cannot be written", () => {
		// A directory where today's day-file should be makes the append throw.
		mkdirSync(`${dir()}/${stamp(new Date())}.jsonl`, { recursive: true });
		expect(() => postToSenderInbox(SENDER, reply("x".repeat(20_000)))).toThrow();
		expect(readdirSync(`${dir()}/bodies`)).toEqual([]);
	});

	it("returns an item that lands during a cursorless wait's last poll instead of skipping it", async () => {
		vi.useFakeTimers();
		const parked = waitForSenderItems(SENDER, { timeoutMs: 1_500 });
		await vi.advanceTimersByTimeAsync(1_200);
		// Appended by another instance: no local wake-up, caught only by the final scan.
		const row = { v: 1, kind: "item", id: "late-row", at: new Date().toISOString(), ...reply("late") };
		appendFileSync(`${dir()}/${stamp(new Date())}.jsonl`, `${JSON.stringify(row)}\n`);
		await vi.advanceTimersByTimeAsync(400);
		expect((await parked).items.map((i) => i.id)).toEqual(["late-row"]);
	});

	it("deletes the spilled bodies of a pruned day, acknowledged ones included", () => {
		mkdirSync(`${dir()}/bodies`, { recursive: true });
		const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
		const body = `${dir()}/bodies/acked.md`;
		writeFileSync(body, "big");
		writeFileSync(`${dir()}/${stamp(old)}.jsonl`, [
			JSON.stringify({ v: 1, kind: "item", id: "acked", at: old.toISOString(), ...reply(), spillPath: body }),
			JSON.stringify({ v: 1, kind: "item", id: "gone", at: old.toISOString(), ...reply(), spillPath: `${dir()}/bodies/missing.md` }),
			JSON.stringify({ v: 1, kind: "ack", at: old.toISOString(), ids: ["acked"], clientId: "c1" }),
		].join("\n") + "\n");
		pruneSenderInbox(SENDER);
		expect(existsSync(body)).toBe(false);
	});

	it("never appends into a day-file older than the newest, so no row lands behind a cursor", () => {
		mkdirSync(dir(), { recursive: true });
		const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
		writeFileSync(`${dir()}/${stamp(tomorrow)}.jsonl`, "");
		postToSenderInbox(SENDER, reply("late"));
		expect(readFileSync(`${dir()}/${stamp(tomorrow)}.jsonl`, "utf8")).toContain('"late"');
		expect(existsSync(`${dir()}/${stamp(new Date())}.jsonl`)).toBe(false);
	});

	it("writes a pruned row before deleting a day-file past 30 days", () => {
		mkdirSync(dir(), { recursive: true });
		const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
		const oldFile = `${dir()}/${stamp(old)}.jsonl`;
		writeFileSync(oldFile, `${JSON.stringify({ v: 1, kind: "item", id: "ancient", at: old.toISOString(), ...reply() })}\n`);
		pruneSenderInbox(SENDER);
		expect(existsSync(oldFile)).toBe(false);
		const rows = rowsOf(`${dir()}/${stamp(new Date())}.jsonl`);
		expect(rows).toEqual([expect.objectContaining({ kind: "pruned", day: stamp(old), unacked: 1 })]);
	});
});

describe("the reader lease", () => {
	it("refuses a second client while the first is parked or within its grace, then lets it in", () => {
		vi.useFakeTimers();
		const release = acquireSenderLease(SENDER, "c1");
		expect(() => acquireSenderLease(SENDER, "c2")).toThrow(SENDER_INBOX_BUSY_ERROR);
		release();
		expect(() => acquireSenderLease(SENDER, "c2")).toThrow(SENDER_INBOX_BUSY_ERROR);
		expect(() => requireSenderLease(SENDER, "c2")).toThrow(SENDER_INBOX_BUSY_ERROR);
		// The holder keeps it by waiting again within the grace window.
		acquireSenderLease(SENDER, "c1")();
		vi.advanceTimersByTime(SENDER_LEASE_GRACE_MS + 1);
		expect(() => acquireSenderLease(SENDER, "c2")).not.toThrow();
	});

	it("hands the lease over only on an explicit take-over", () => {
		acquireSenderLease(SENDER, "c1");
		expect(() => acquireSenderLease(SENDER, "c2", true)).not.toThrow();
		expect(() => requireSenderLease(SENDER, "c1")).toThrow(SENDER_INBOX_BUSY_ERROR);
	});
});

describe("socket handlers", () => {
	it("a peek (no client, timeout 0) never touches the lease", async () => {
		acquireSenderLease(SENDER, "c1");
		await expect(externalSenderHandlers["sender.wait"]({ senderId: SENDER, timeoutMs: 0 })).resolves.toMatchObject({ items: [] });
		await expect(externalSenderHandlers["sender.wait"]({ senderId: SENDER, clientId: "c2", timeoutMs: 0 })).rejects.toThrow(SENDER_INBOX_BUSY_ERROR);
	});

	it("a post names the task that wrote it and needs one", async () => {
		await expect(externalSenderHandlers["sender.post"]({ senderId: SENDER, text: "hi", subject: "s" })).rejects.toThrow(/inside a task worktree/);
		const posted = await externalSenderHandlers["sender.post"]({ senderId: SENDER, sourceTaskId: "worker-task", text: "hi", subject: "s", inReplyTo: "m-9" }) as { itemId: string };
		const { items } = await waitForSenderItems(SENDER, {});
		expect(items).toEqual([expect.objectContaining({ id: posted.itemId, fromSeq: 26, fromTitle: "Worker", inReplyTo: "m-9", subject: "s" })]);
	});

	it("refuses an unregistered sender on every handler", async () => {
		for (const method of ["sender.post", "sender.wait", "sender.ack"]) {
			await expect(externalSenderHandlers[method]({ senderId: "ghost", clientId: "c", ids: ["x"], sourceTaskId: "worker-task", text: "t", subject: "s" }))
				.rejects.toThrow(/^Unknown external sender/);
		}
	});
});
