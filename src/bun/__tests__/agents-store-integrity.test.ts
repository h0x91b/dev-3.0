import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingAgent } from "../../shared/types";
import { DEFAULT_AGENTS } from "../../shared/types";

const { TEST_HOME, AGENTS_FILE, LKG_FILE } = vi.hoisted(() => {
	const home = `${process.env.DEV3_TEST_ROOT}/agents-store-integrity`;
	return { TEST_HOME: home, AGENTS_FILE: `${home}/agents.json`, LKG_FILE: `${home}/agents-last-known-good.json` };
});

vi.mock("../paths", () => ({ DEV3_HOME: TEST_HOME }));
const push = vi.hoisted(() => vi.fn());
vi.mock("../rpc-handlers/shared-pure", async (importOriginal) => ({
	...(await importOriginal<typeof import("../rpc-handlers/shared-pure")>()),
	getPushMessage: () => push,
}));
vi.mock("../settings", () => ({
	loadSettings: vi.fn(async () => ({ agentsLayoutRevision: 999 })),
	saveSettings: vi.fn(async () => undefined),
}));

import { getAgentsStoreNotice, getAllAgents, resetAgentsStoreStateForTests, saveAllAgents } from "../agents";
import { backupCorruptFile } from "../json-store-guard";

/**
 * test-setup stubs Bun.write as a no-op, under which an in-place writer can never
 * race. Give it the real shape: truncate, then write in chunks across ticks, so a
 * concurrent reader can catch the file half-written exactly as #2434 did.
 */
async function chunkedInPlaceWrite(path: string, data: string): Promise<number> {
	const handle = await open(path, "w");
	try {
		for (let offset = 0; offset < data.length; offset += 4096) {
			await handle.write(data.slice(offset, offset + 4096));
			await new Promise((resolve) => setImmediate(resolve));
		}
	} finally {
		await handle.close();
	}
	return data.length;
}

const CUSTOM_PRESET_ID = "user-custom-preset";

/** A stored file the merge will want to rewrite (a built-in agent is missing),
 *  holding one user-authored preset that must never be lost. */
function storedWithCustomPreset(): CodingAgent[] {
	const claude = DEFAULT_AGENTS.find((agent) => agent.id === "builtin-claude")!;
	// Padding makes a write span many chunks, the way a real ~270 KB agents.json does.
	const padding = Array.from({ length: 300 }, (_, i) => ({ id: `pad-${i}`, name: `Pad ${i}`, model: "claude-opus-5", envVars: { PAD: "x".repeat(200) } }));
	return [{
		...claude,
		configurations: [...claude.configurations, ...padding, { id: CUSTOM_PRESET_ID, name: "Mine", model: "claude-opus-5" }],
	}];
}

function hasCustomPreset(agents: CodingAgent[]): boolean {
	return agents.some((agent) => agent.configurations.some((config) => config.id === CUSTOM_PRESET_ID));
}

function corruptBackups(): string[] {
	return readdirSync(TEST_HOME).filter((name) => name.startsWith("agents.json.corrupt-"));
}

let originalBunWrite: unknown;

beforeEach(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
	mkdirSync(TEST_HOME, { recursive: true });
	resetAgentsStoreStateForTests();
	push.mockReset();
	originalBunWrite = (globalThis as any).Bun.write;
	(globalThis as any).Bun.write = chunkedInPlaceWrite;
});

afterEach(() => {
	(globalThis as any).Bun.write = originalBunWrite;
	rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("agents.json integrity (h0x91b/dev-3.0#2434)", () => {
	it("never overwrites an unparsable agents.json with defaults, and backs the bytes up", async () => {
		const full = JSON.stringify(storedWithCustomPreset(), null, 2);
		const torn = full.slice(0, Math.floor(full.length / 2));
		writeFileSync(AGENTS_FILE, torn);

		const agents = await getAllAgents();

		expect(agents.length).toBeGreaterThan(0);
		expect(readFileSync(AGENTS_FILE, "utf8")).toBe(torn);
		const backups = corruptBackups();
		expect(backups).toHaveLength(1);
		expect(readFileSync(`${TEST_HOME}/${backups[0]}`, "utf8")).toBe(torn);
	});

	it("backs up the same corrupt bytes once, not on every read", async () => {
		writeFileSync(AGENTS_FILE, "{ not json");
		await getAllAgents();
		await getAllAgents();
		expect(corruptBackups()).toHaveLength(1);
	});

	it("treats an empty agents.json as unreadable, not as an empty preset list", async () => {
		writeFileSync(AGENTS_FILE, "");
		await getAllAgents();
		expect(readFileSync(AGENTS_FILE, "utf8")).toBe("");
	});

	it("recovers from the last-known-good copy when agents.json is unparsable", async () => {
		writeFileSync(LKG_FILE, JSON.stringify(storedWithCustomPreset()));
		writeFileSync(AGENTS_FILE, "[{\"id\": \"builtin-cl");

		const agents = await getAllAgents();

		expect(hasCustomPreset(agents)).toBe(true);
		const persisted = JSON.parse(readFileSync(AGENTS_FILE, "utf8")) as CodingAgent[];
		expect(hasCustomPreset(persisted)).toBe(true);
		expect(corruptBackups()).toHaveLength(1);
	});

	it("ignores an unparsable last-known-good copy and still refuses to overwrite", async () => {
		writeFileSync(LKG_FILE, "garbage");
		writeFileSync(AGENTS_FILE, "also garbage");
		await getAllAgents();
		expect(readFileSync(AGENTS_FILE, "utf8")).toBe("also garbage");
	});

	it("rides out a torn read from an in-place writer instead of falling back to defaults", async () => {
		// An older app version still writes agents.json in place; a reader can catch it mid-write.
		const full = JSON.stringify(storedWithCustomPreset(), null, 2);
		writeFileSync(AGENTS_FILE, full.slice(0, 100));
		const finishWrite = new Promise<void>((resolve) => {
			setTimeout(() => {
				writeFileSync(AGENTS_FILE, full);
				resolve();
			}, 15);
		});

		const agents = await getAllAgents();
		await finishWrite;

		expect(hasCustomPreset(agents)).toBe(true);
		expect(hasCustomPreset(JSON.parse(readFileSync(AGENTS_FILE, "utf8")))).toBe(true);
		expect(corruptBackups()).toHaveLength(0);
	});

	it("keeps custom presets through staggered startup reads that each want to persist the merge", async () => {
		writeFileSync(AGENTS_FILE, JSON.stringify(storedWithCustomPreset(), null, 2));

		const pending: Promise<CodingAgent[]>[] = [];
		for (let i = 0; i < 60; i++) {
			pending.push(getAllAgents());
			await new Promise((resolve) => setImmediate(resolve));
		}
		const results = await Promise.all(pending);

		for (const agents of results) expect(hasCustomPreset(agents)).toBe(true);
		expect(hasCustomPreset(JSON.parse(readFileSync(AGENTS_FILE, "utf8")))).toBe(true);
	});

	it("never exposes invalid JSON to a reader while writers race", async () => {
		const base = storedWithCustomPreset();
		writeFileSync(AGENTS_FILE, JSON.stringify(base, null, 2));
		let stop = false;
		let reads = 0;
		const reader = (async () => {
			while (!stop) {
				const raw = readFileSync(AGENTS_FILE, "utf8");
				JSON.parse(raw); // throws — and fails the test — on a torn file
				reads++;
				await new Promise((resolve) => setImmediate(resolve));
			}
		})();

		const writers = Array.from({ length: 20 }, (_, i) =>
			i % 2 === 0 ? saveAllAgents(base) : getAllAgents().then(() => undefined));
		await Promise.all(writers);
		stop = true;
		await reader;

		expect(reads).toBeGreaterThan(0);
		expect(hasCustomPreset(JSON.parse(readFileSync(AGENTS_FILE, "utf8")))).toBe(true);
		expect(readdirSync(TEST_HOME).filter((name) => name.includes(".tmp-"))).toHaveLength(0);
	});

	it("judges a persistently unreadable file once per file state, not on every read", async () => {
		writeFileSync(AGENTS_FILE, "{ broken");
		await getAllAgents();
		expect(push).toHaveBeenCalledTimes(1);

		const started = Date.now();
		await getAllAgents();
		await getAllAgents();
		expect(Date.now() - started).toBeLessThan(100); // no torn-read retries the second time
		expect(push).toHaveBeenCalledTimes(1);

		writeFileSync(AGENTS_FILE, "{ broken differently");
		await getAllAgents();
		expect(push).toHaveBeenCalledTimes(2);
		expect(corruptBackups()).toHaveLength(2);
	});

	it("tells the user when it serves defaults over an unreadable file, naming the backup", async () => {
		writeFileSync(AGENTS_FILE, "nope");
		await getAllAgents();
		const backup = corruptBackups()[0];
		expect(push).toHaveBeenCalledWith("agentsStoreNotice", { kind: "unreadable", backupFile: backup });
		expect(getAgentsStoreNotice()).toEqual({ kind: "unreadable", backupFile: backup });
	});

	it("drops the unreadable notice once agents.json reads again", async () => {
		writeFileSync(AGENTS_FILE, "nope");
		await getAllAgents();
		await saveAllAgents(storedWithCustomPreset());
		await getAllAgents();
		expect(getAgentsStoreNotice()).toBeNull();
	});

	it("tells the user when it restored presets from the last-known-good copy", async () => {
		writeFileSync(LKG_FILE, JSON.stringify(storedWithCustomPreset()));
		writeFileSync(AGENTS_FILE, "]");
		await getAllAgents();
		expect(push).toHaveBeenCalledWith("agentsStoreNotice", { kind: "recovered", backupFile: corruptBackups()[0] });
		// The restore rewrote the file, so the notice is not raised again on the next read.
		await getAllAgents();
		expect(push).toHaveBeenCalledTimes(1);
	});

	it("writes one backup when many callers back up the same bytes at once", async () => {
		const paths = await Promise.all(Array.from({ length: 10 }, () => backupCorruptFile(AGENTS_FILE, "same bytes")));
		expect(new Set(paths).size).toBe(1);
		expect(paths[0]).not.toBeNull();
		expect(corruptBackups()).toHaveLength(1);
	});

	it("still seeds defaults when agents.json does not exist", async () => {
		const agents = await getAllAgents();
		expect(agents.length).toBe(DEFAULT_AGENTS.length);
		expect(existsSync(AGENTS_FILE)).toBe(true);
		expect(corruptBackups()).toHaveLength(0);
	});
});
