import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionListing } from "../../registry";
import {
	KEEP_RECENT_MS,
	liveHostExecutables,
	pruneHostImageRoot,
	pruneHostImages,
	STALE_STAGING_MS,
} from "../prune";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);

let root: string;
let outside: string;

function makeDir(parent: string, name: string, ageMs: number): string {
	const dir = join(parent, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "dev3-terminal-host"), "x");
	const when = new Date(NOW - ageMs);
	utimesSync(dir, when, when);
	return dir;
}

const tag = (n: number): string => `1.0.${n}-p1-${String(n).padStart(12, "a")}`;

/** Two recent images first, so an image under test is never among the newest two. */
function makeNewestTwo(): void {
	makeDir(root, tag(98), 1 * DAY);
	makeDir(root, tag(99), 2 * DAY);
}

const OLD = 10 * DAY;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dev3-host-prune-"));
	outside = mkdtempSync(join(tmpdir(), "dev3-host-prune-outside-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

describe("pruneHostImageRoot retention", () => {
	it("keeps the two newest images however old they are", async () => {
		makeDir(root, tag(1), 30 * DAY);
		makeDir(root, tag(2), 20 * DAY);
		const report = await pruneHostImageRoot({ root, now: NOW, liveExecutables: [] });
		expect(report.deleted).toEqual([]);
		expect(existsSync(join(root, tag(1)))).toBe(true);
		expect(existsSync(join(root, tag(2)))).toBe(true);
	});

	it("keeps an old image that was used 3 days ago", async () => {
		makeNewestTwo();
		makeDir(root, tag(3), 3 * DAY);
		await pruneHostImageRoot({ root, now: NOW, liveExecutables: [] });
		expect(existsSync(join(root, tag(3)))).toBe(true);
	});

	it("deletes an image unused for over 7 days that is not among the newest and has no sessions", async () => {
		makeNewestTwo();
		makeDir(root, tag(3), OLD);
		const report = await pruneHostImageRoot({ root, now: NOW, liveExecutables: [] });
		expect(report.deleted).toEqual([tag(3)]);
		expect(existsSync(join(root, tag(3)))).toBe(false);
	});

	it("keeps an image just inside the 7 day window and deletes one just outside it", async () => {
		makeNewestTwo();
		makeDir(root, tag(3), KEEP_RECENT_MS - 1000);
		makeDir(root, tag(4), KEEP_RECENT_MS + 1000);
		await pruneHostImageRoot({ root, now: NOW, liveExecutables: [] });
		expect(existsSync(join(root, tag(3)))).toBe(true);
		expect(existsSync(join(root, tag(4)))).toBe(false);
	});

	it("keeps an old image a live session runs from", async () => {
		makeNewestTwo();
		const dir = makeDir(root, tag(3), OLD);
		await pruneHostImageRoot({ root, now: NOW, liveExecutables: [join(dir, "dev3-terminal-host")] });
		expect(existsSync(dir)).toBe(true);
	});

	it("does not mistake a sibling tag sharing a name prefix for the same image", async () => {
		makeNewestTwo();
		makeDir(root, tag(3), OLD);
		const sibling = `${tag(3)}-p2-000000000000`;
		makeDir(root, sibling, OLD);
		await pruneHostImageRoot({ root, now: NOW, liveExecutables: [join(root, sibling, "dev3-terminal-host")] });
		expect(existsSync(join(root, tag(3)))).toBe(false);
		expect(existsSync(join(root, sibling))).toBe(true);
	});
});

describe("pruneHostImageRoot path matching", () => {
	it("keeps an image reached through a symlinked root when the session names the real path", async () => {
		makeNewestTwo();
		const dir = makeDir(root, tag(3), OLD);
		const linkRoot = join(outside, "link-root");
		symlinkSync(root, linkRoot, "dir");
		await pruneHostImageRoot({ root: linkRoot, now: NOW, liveExecutables: [join(dir, "dev3-terminal-host")] });
		expect(existsSync(dir)).toBe(true);
	});

	it("keeps an image when the session names the executable through a symlink to the root", async () => {
		makeNewestTwo();
		const dir = makeDir(root, tag(3), OLD);
		const linkRoot = join(outside, "link-root");
		symlinkSync(root, linkRoot, "dir");
		await pruneHostImageRoot({ root, now: NOW, liveExecutables: [join(linkRoot, tag(3), "dev3-terminal-host")] });
		expect(existsSync(dir)).toBe(true);
	});
});

describe("pruneHostImageRoot only touches what it owns", () => {
	it("leaves foreign names alone", async () => {
		makeNewestTwo();
		makeDir(root, "foo", OLD);
		makeDir(root, "notes", OLD);
		writeFileSync(join(root, ".DS_Store"), "x");
		const report = await pruneHostImageRoot({ root, now: NOW, liveExecutables: [] });
		expect(report.deleted).toEqual([]);
		expect(existsSync(join(root, "foo"))).toBe(true);
		expect(existsSync(join(root, "notes"))).toBe(true);
		expect(existsSync(join(root, ".DS_Store"))).toBe(true);
	});

	it("leaves a symlink with a valid tag name and its target untouched", async () => {
		makeNewestTwo();
		const target = makeDir(outside, "precious", OLD);
		symlinkSync(target, join(root, tag(3)), "dir");
		const report = await pruneHostImageRoot({ root, now: NOW, liveExecutables: [] });
		expect(report.deleted).toEqual([]);
		expect(existsSync(join(target, "dev3-terminal-host"))).toBe(true);
		expect(existsSync(join(root, tag(3)))).toBe(true);
	});

	it("leaves a plain file with a valid tag name alone", async () => {
		makeNewestTwo();
		writeFileSync(join(root, tag(3)), "not a directory");
		const report = await pruneHostImageRoot({ root, now: NOW, liveExecutables: [] });
		expect(report.deleted).toEqual([]);
		expect(statSync(join(root, tag(3))).isFile()).toBe(true);
	});
});

describe("pruneHostImageRoot scratch directories", () => {
	it("deletes a .staging-* directory older than 24h and keeps a younger one", async () => {
		makeDir(root, `.staging-${tag(5)}-AbC123`, STALE_STAGING_MS + 60_000);
		makeDir(root, `.staging-${tag(6)}-XyZ789`, STALE_STAGING_MS - 60_000);
		const report = await pruneHostImageRoot({ root, now: NOW, liveExecutables: [] });
		expect(report.deletedStaging).toEqual([`.staging-${tag(5)}-AbC123`]);
		expect(existsSync(join(root, `.staging-${tag(5)}-AbC123`))).toBe(false);
		expect(existsSync(join(root, `.staging-${tag(6)}-XyZ789`))).toBe(true);
	});

	it("leaves a .staging-* symlink alone", async () => {
		const target = makeDir(outside, "scratch", OLD);
		symlinkSync(target, join(root, ".staging-link"), "dir");
		const report = await pruneHostImageRoot({ root, now: NOW, liveExecutables: [] });
		expect(report.deletedStaging).toEqual([]);
		expect(existsSync(join(target, "dev3-terminal-host"))).toBe(true);
	});
});

describe("pruneHostImageRoot failure handling", () => {
	it("does nothing and does not throw when the root is missing", async () => {
		const report = await pruneHostImageRoot({ root: join(root, "missing"), now: NOW, liveExecutables: [] });
		expect(report).toEqual({ deleted: [], deletedStaging: [], failed: [], kept: 0 });
	});

	it("reports a failed delete and still prunes the others", async () => {
		makeNewestTwo();
		makeDir(root, tag(3), OLD);
		makeDir(root, tag(4), OLD + DAY);
		const report = await pruneHostImageRoot({
			root,
			now: NOW,
			liveExecutables: [],
			removeDir: async (path) => {
				if (path.endsWith(tag(3))) throw new Error("EBUSY: resource busy");
				await rm(path, { recursive: true, force: true });
			},
		});
		expect(report.failed).toEqual([{ name: tag(3), error: expect.stringContaining("EBUSY") }]);
		expect(report.deleted).toEqual([tag(4)]);
		expect(existsSync(join(root, tag(3)))).toBe(true);
		expect(existsSync(join(root, tag(4)))).toBe(false);
	});
});

function session(state: SessionListing["state"], executable: string): SessionListing {
	return { sessionId: `s-${state}`, state, record: { host: { executable } } } as unknown as SessionListing;
}

describe("an image is whole or gone", () => {
	it("stops at a runtime carrier that cannot be removed and leaves the rest of the image intact", async () => {
		makeNewestTwo();
		const dir = makeDir(root, tag(3), OLD);
		writeFileSync(join(dir, "image.json"), "{}");
		writeFileSync(join(dir, "dev3-terminal-host.js"), "//");
		rmSync(join(dir, "dev3-terminal-host"));
		mkdirSync(join(dir, "dev3-terminal-host", "locked"), { recursive: true }); // unlink of a directory fails, like a locked exe
		const when = new Date(NOW - OLD);
		utimesSync(dir, when, when); // the edits above refreshed the mtime
		const report = await pruneHostImageRoot({ root, now: NOW, liveExecutables: [] });
		expect(report.deleted).toEqual([]);
		expect(report.failed.map((failure) => failure.name)).toEqual([tag(3)]);
		expect(existsSync(join(dir, "image.json"))).toBe(true);
		expect(existsSync(join(dir, "dev3-terminal-host.js"))).toBe(true);
	});
});

describe("session liveness", () => {
	it("protects images of running and reused sessions but not dead ones", () => {
		expect(liveHostExecutables([session("running", "/a"), session("reused", "/b"), session("dead", "/c")])).toEqual([
			"/a",
			"/b",
		]);
	});

	it("protects a dead session's image while its host pid is still alive", async () => {
		makeNewestTwo();
		const dir = makeDir(root, tag(3), OLD);
		const gone = makeDir(root, tag(4), OLD);
		const hostPid = (executable: string): SessionListing => {
			const listing = session("dead", executable);
			listing.record.host.pid = executable.includes(tag(3)) ? 111 : 222;
			return listing;
		};
		const report = await pruneHostImages({
			root,
			now: NOW,
			isHostAlive: (pid) => pid === 111,
			readSessions: async () => [
				hostPid(join(dir, "dev3-terminal-host")),
				hostPid(join(gone, "dev3-terminal-host")),
			],
		});
		expect(report?.deleted).toEqual([tag(4)]);
		expect(existsSync(dir)).toBe(true);
	});

	it("deletes an old image whose only session is dead, keeps ones whose session is owned or reused", async () => {
		makeNewestTwo();
		const owned = makeDir(root, tag(3), OLD);
		const reused = makeDir(root, tag(4), OLD);
		const dead = makeDir(root, tag(5), OLD);
		const report = await pruneHostImages({
			root,
			now: NOW,
			isHostAlive: () => false,
			readSessions: async () => [
				session("running", join(owned, "dev3-terminal-host")),
				session("reused", join(reused, "dev3-terminal-host")),
				session("dead", join(dead, "dev3-terminal-host")),
			],
		});
		expect(report?.deleted).toEqual([tag(5)]);
		expect(existsSync(owned)).toBe(true);
		expect(existsSync(reused)).toBe(true);
	});

	it("deletes nothing when the session list cannot be read", async () => {
		makeNewestTwo();
		const dir = makeDir(root, tag(3), OLD);
		const report = await pruneHostImages({
			root,
			now: NOW,
			readSessions: async () => {
				throw new Error("registry unreadable");
			},
		});
		expect(report).toBeNull();
		expect(existsSync(dir)).toBe(true);
	});

	it("skips a second prune that starts while one is running", async () => {
		makeNewestTwo();
		makeDir(root, tag(3), OLD);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = pruneHostImages({ root, now: NOW, readSessions: async () => (await gate, []) });
		const second = await pruneHostImages({ root, now: NOW, readSessions: async () => [] });
		expect(second).toBeNull();
		release();
		expect((await first)?.deleted).toEqual([tag(3)]);
	});
});
