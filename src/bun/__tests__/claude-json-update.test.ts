import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { acquireClaudeJsonLock, claudeJsonLockPath, updateClaudeJson } from "../claude-json-update";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function addKey(key: string) {
	return (data: Record<string, unknown>) => {
		const projects = (data.projects ?? {}) as Record<string, unknown>;
		if (projects[key]) return false;
		data.projects = { ...projects, [key]: { hasTrustDialogAccepted: true } };
		return true;
	};
}

function projectKeys(file: string): string[] {
	return Object.keys(JSON.parse(readFileSync(file, "utf-8")).projects ?? {}).sort();
}

/**
 * What Claude Code 2.1.310 does on every config save: take `<file>.lock` by
 * mkdir, read the file under it, write its own change, rename it into place.
 * `holdMs` widens the window between its read and its write.
 */
async function claudeLikeLockedSave(file: string, key: string, holdMs: number): Promise<void> {
	await mkdir(claudeJsonLockPath(file));
	try {
		const data = JSON.parse(await readFile(file, "utf-8"));
		await wait(holdMs);
		data.projects = { ...data.projects, [key]: { hasTrustDialogAccepted: true } };
		await writeFile(`${file}.claude.tmp`, JSON.stringify(data));
		await rename(`${file}.claude.tmp`, file);
	} finally {
		await rmdir(claudeJsonLockPath(file));
	}
}

/** dev3's old trust write: read, modify, write back — no lock, no check. */
async function legacyUnlockedWrite(file: string, key: string): Promise<void> {
	const data = JSON.parse(await readFile(file, "utf-8"));
	data.projects = { ...data.projects, [key]: { hasTrustDialogAccepted: true } };
	await writeFile(file, JSON.stringify(data));
}

describe("updateClaudeJson", () => {
	let dir = "";
	let file = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "dev3-claude-json-"));
		file = join(dir, ".claude.json");
		writeFileSync(file, JSON.stringify({ oauthAccount: { id: "x" }, projects: { "/repo/a": { hasTrustDialogAccepted: true } } }));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reproduces the lost update with the old unlocked write (control for the race below)", async () => {
		const claude = claudeLikeLockedSave(file, "/claude/own", 150);
		await wait(30);
		await legacyUnlockedWrite(file, "/wt/new");
		await claude;

		expect(projectKeys(file)).not.toContain("/wt/new");
	});

	it("keeps a trust entry written while Claude Code holds its lock (#2034)", async () => {
		const claude = claudeLikeLockedSave(file, "/claude/own", 150);
		await wait(30);
		expect(await updateClaudeJson(file, addKey("/wt/new"))).toBe("written");
		await claude;

		expect(projectKeys(file)).toEqual(["/claude/own", "/repo/a", "/wt/new"]);
		expect(JSON.parse(readFileSync(file, "utf-8")).oauthAccount).toEqual({ id: "x" });
		expect(existsSync(claudeJsonLockPath(file))).toBe(false);
	});

	it("re-reads instead of clobbering a writer that ignores the lock", async () => {
		let calls = 0;
		const result = await updateClaudeJson(file, (data) => {
			calls++;
			if (calls === 1) {
				// Someone rewrote the file after our read; our copy is now stale.
				writeFileSync(file, JSON.stringify({ projects: { "/repo/a": {}, "/other/writer": {} }, extra: true }, null, 4));
			}
			return addKey("/wt/new")(data);
		});

		expect(result).toBe("written");
		expect(calls).toBe(2);
		expect(projectKeys(file)).toEqual(["/other/writer", "/repo/a", "/wt/new"]);
		expect(JSON.parse(readFileSync(file, "utf-8")).extra).toBe(true);
	});

	it("replaces the file by rename and keeps its permissions", async () => {
		chmodSync(file, 0o600);
		const inodeBefore = statSync(file).ino;
		await updateClaudeJson(file, addKey("/wt/new"));

		expect(statSync(file).ino).not.toBe(inodeBefore);
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	it("never rewrites a file it cannot parse", async () => {
		writeFileSync(file, "{ not json");
		expect(await updateClaudeJson(file, addKey("/wt/new"))).toBe("unparsable");
		expect(readFileSync(file, "utf-8")).toBe("{ not json");
	});

	it("does not write when nothing changes", async () => {
		const mtime = statSync(file).mtimeMs;
		expect(await updateClaudeJson(file, addKey("/repo/a"))).toBe("unchanged");
		expect(statSync(file).mtimeMs).toBe(mtime);
	});

	it("creates a missing file", async () => {
		rmSync(file);
		expect(await updateClaudeJson(file, addKey("/wt/new"))).toBe("written");
		expect(projectKeys(file)).toEqual(["/wt/new"]);
	});
});

describe("acquireClaudeJsonLock", () => {
	let dir = "";
	let file = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "dev3-claude-lock-"));
		file = join(dir, ".claude.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("waits for a live holder to let go", async () => {
		mkdirSync(claudeJsonLockPath(file));
		const sleeps: number[] = [];
		const release = await acquireClaudeJsonLock(file, {
			sleep: async (ms) => {
				sleeps.push(ms);
				if (sleeps.length === 40) rmSync(claudeJsonLockPath(file), { recursive: true });
			},
		});

		expect(release).not.toBeNull();
		expect(sleeps).toHaveLength(40);
		await release!();
		expect(existsSync(claudeJsonLockPath(file))).toBe(false);
	});

	it("takes over a lock whose holder stopped refreshing it", async () => {
		mkdirSync(claudeJsonLockPath(file));
		const old = new Date(Date.now() - 60_000);
		utimesSync(claudeJsonLockPath(file), old, old);

		const release = await acquireClaudeJsonLock(file, { sleep: async () => {} });
		expect(release).not.toBeNull();
		await release!();
	});

	it("waits out the whole stale window for a live lock, then gives up leaving it in place", async () => {
		mkdirSync(claudeJsonLockPath(file));
		let clock = 0;
		const release = await acquireClaudeJsonLock(file, { now: () => clock, sleep: async (ms) => { clock += ms; } });

		expect(release).toBeNull();
		expect(existsSync(claudeJsonLockPath(file))).toBe(true);
	});

	it("still writes, verified, when the lock never frees", async () => {
		writeFileSync(file, JSON.stringify({ projects: {} }));
		mkdirSync(claudeJsonLockPath(file));
		const result = await updateClaudeJson(file, addKey("/wt/new"), { lockWaitMs: 0 });

		expect(result).toBe("written");
		expect(projectKeys(file)).toEqual(["/wt/new"]);
		expect(existsSync(claudeJsonLockPath(file))).toBe(true);
	});
});
