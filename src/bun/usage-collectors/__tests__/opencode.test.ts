import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newUsageState } from "../../rpc-handlers/agent-usage-parse";
import { queryReadonlySqlite, readonlySqliteTarget } from "../../sqlite-readonly";
import { collectOpenCodeUsage, openCodeDatabases } from "../opencode";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
	DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...args: unknown[]): void }; close(): void };
};

let home: string;
const at = Date.parse("2026-10-25T12:00:00Z");
const dataDir = () => join(home, ".local", "share", "opencode");

// The upstream 1.18 schema, reduced to the columns the collector reads.
function createDb(path: string, rows: { messages: [string, unknown][]; parts: [string, string, unknown, number?][] }, wal = false): void {
	mkdirSync(join(path, ".."), { recursive: true });
	const db = new DatabaseSync(path);
	if (wal) db.exec("PRAGMA journal_mode = WAL");
	db.exec(`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
		CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);`);
	const message = db.prepare("INSERT INTO message VALUES (?, 's', ?, ?, ?)");
	for (const [id, data] of rows.messages) message.run(id, at, at, JSON.stringify(data));
	const part = db.prepare("INSERT INTO part VALUES (?, ?, 's', ?, ?, ?)");
	for (const [id, messageId, data, created = at] of rows.parts) part.run(id, messageId, created, created, JSON.stringify(data));
	db.close();
}
const assistant = (modelID = "claude-sonnet-4-6") => ({
	role: "assistant", modelID, providerID: "anthropic", time: { created: at },
	cost: 1, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
});
const step = (input: number, output: number, reasoning = 0, read = 0, write = 0) => ({
	type: "step-finish", reason: "tool-calls", cost: 0.5, tokens: { total: input + output, input, output, reasoning, cache: { read, write } },
});

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dev3-opencode-usage-"));
	vi.spyOn(process, "emitWarning").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(home, { recursive: true, force: true });
});

describe("collectOpenCodeUsage", () => {
	it("counts every step of a message instead of its last-step tokens, reasoning priced as output", () => {
		createDb(join(dataDir(), "opencode.db"), {
			messages: [["msg1", assistant()], ["user1", { role: "user", content: "private prompt" }]],
			parts: [
				["p1", "msg1", step(100, 10, 5, 1_000, 200)],
				["p2", "msg1", step(50, 20), at + 1_000],
				["p3", "msg1", { type: "text", text: "private answer mentioning step-finish" }],
				["p4", "user1", step(9, 9)],
			],
		});
		const state = newUsageState();
		collectOpenCodeUsage(state, openCodeDatabases(home, {}), queryReadonlySqlite);
		expect([...state.records.values()].map((r) => [r.model, r.timestamp, r.counts])).toEqual([
			["claude-sonnet-4-6", at, { inputTokens: 100, outputTokens: 15, cacheReadInputTokens: 1_000, cacheCreationInputTokens: 200 }],
			["claude-sonnet-4-6", at + 1_000, { inputTokens: 50, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }],
		]);
	});

	it("deduplicates parts copied into channel databases and honours an OPENCODE_DB override", () => {
		const rows = { messages: [["msg1", assistant()]] as [string, unknown][], parts: [["p1", "msg1", step(1, 1)]] as [string, string, unknown][] };
		createDb(join(dataDir(), "opencode.db"), rows);
		createDb(join(dataDir(), "opencode-beta.db"), { ...rows, parts: [...rows.parts, ["p2", "msg1", step(2, 2)]] });
		createDb(join(home, "custom.db"), { ...rows, parts: [["p3", "msg1", step(3, 3)]] });
		writeFileSync(join(dataDir(), "opencode.db-notes.txt"), "not a database");
		const databases = openCodeDatabases(home, { OPENCODE_DB: join(home, "custom.db") });
		expect(databases).toHaveLength(3);
		const state = newUsageState();
		collectOpenCodeUsage(state, databases, queryReadonlySqlite);
		expect(state.records.size).toBe(3);
	});

	it("skips malformed rows, negative counts and unreadable databases without dropping the rest", () => {
		createDb(join(dataDir(), "opencode.db"), {
			messages: [["msg1", assistant("")], ["msg2", assistant()]],
			parts: [["p1", "msg1", step(1, 1)], ["p2", "msg2", step(-1, 1)], ["p3", "msg2", { type: "step-finish" }], ["p4", "msg2", step(0, 0)]],
		});
		writeFileSync(join(dataDir(), "opencode-broken.db"), "not sqlite");
		const warn = vi.fn();
		const state = newUsageState();
		collectOpenCodeUsage(state, openCodeDatabases(home, {}), queryReadonlySqlite, warn);
		expect([...state.records.values()].map((r) => r.model)).toEqual(["unknown"]);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("reads XDG data dirs and reports no databases when OpenCode is absent", () => {
		expect(openCodeDatabases(home, {})).toEqual([]);
		createDb(join(home, "xdg", "opencode", "opencode.db"), { messages: [], parts: [] });
		expect(openCodeDatabases(home, { XDG_DATA_HOME: join(home, "xdg") })).toEqual([join(home, "xdg", "opencode", "opencode.db")]);
	});
});

describe("readonlySqliteTarget", () => {
	it("opens a checkpointed database immutably and a live WAL database normally", () => {
		expect(readonlySqliteTarget("/a b/x?.db", false)).toBe("file:/a%20b/x%3F.db?mode=ro&immutable=1");
		expect(readonlySqliteTarget("/a/x.db", true)).toBe("/a/x.db");
	});

	it("never creates sidecar files beside a checkpointed database", () => {
		const path = join(dataDir(), "opencode.db");
		createDb(path, { messages: [["msg1", assistant()]], parts: [["p1", "msg1", step(1, 1)]] }, true);
		for (const name of readdirSync(dataDir())) if (name !== "opencode.db") rmSync(join(dataDir(), name));
		collectOpenCodeUsage(newUsageState(), [path], queryReadonlySqlite);
		expect(readdirSync(dataDir())).toEqual(["opencode.db"]);
	});
});
