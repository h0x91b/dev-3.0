import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OwnershipVerdict } from "../../ownership";
import { NATIVE_SESSIONS_DIR_ENV, recordFile, sessionDir } from "../../paths";
import { NATIVE_SESSION_SCHEMA_VERSION, writeRecordAtomic, type NativeSessionRecord } from "../../record";
import { KEEP_RECENT_MS, pruneHostImageRoot, pruneHostImages, removeImageDirectory, STALE_STAGING_MS } from "../prune";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);

let root: string;
let outside: string;
let sessionsRoot: string;
let savedSessionsEnv: string | undefined;

/** A complete packaged image: manifest naming a carrier and an entrypoint that both exist. */
function makeDir(parent: string, name: string, ageMs: number): string {
	const dir = join(parent, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "dev3-terminal-host"), "x");
	writeFileSync(join(dir, "dev3-terminal-host.js"), "//");
	writeFileSync(
		join(dir, "host-image.json"),
		JSON.stringify({ runtimeCarrier: "dev3-terminal-host", artifact: { entrypoint: "dev3-terminal-host.js" } }),
	);
	setAge(dir, ageMs);
	return dir;
}

function setAge(path: string, ageMs: number): void {
	const when = new Date(NOW - ageMs);
	utimesSync(path, when, when);
}

const tag = (n: number): string => `1.0.${n}-p1-${String(n).padStart(12, "a")}`;

/** Two recent images first, so an image under test is never among the newest two. */
function makeNewestTwo(): void {
	makeDir(root, tag(98), 1 * DAY);
	makeDir(root, tag(99), 2 * DAY);
}

const OLD = 10 * DAY;

function writeSession(sessionId: string, executable: string, hostPid = 4242): void {
	const record: NativeSessionRecord = {
		schemaVersion: NATIVE_SESSION_SCHEMA_VERSION,
		sessionId,
		paneId: `${sessionId}:0`,
		protocolVersion: 1,
		hostArtifactVersion: "1",
		runtimeVersion: "1.3.14",
		platform: process.platform,
		host: { pid: hostPid, executable, startSignature: `${hostPid}@t0` },
		shell: { pid: hostPid + 1, command: ["/bin/sh"], startSignature: `${hostPid + 1}@t0` },
		endpoint: { transport: "ws", address: "127.0.0.1", port: 51234 },
		ownership: { evidenceKind: "posix-start-signature" },
		cols: 80,
		rows: 24,
		createdAt: "2026-07-20T00:00:00.000Z",
		updatedAt: "2026-07-20T00:00:00.000Z",
	};
	writeRecordAtomic(record);
}

const verdicts =
	(byId: Record<string, OwnershipVerdict>) =>
	async (record: NativeSessionRecord): Promise<OwnershipVerdict> =>
		byId[record.sessionId] ?? "dead";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dev3-host-prune-"));
	outside = mkdtempSync(join(tmpdir(), "dev3-host-prune-outside-"));
	sessionsRoot = mkdtempSync(join(tmpdir(), "dev3-host-prune-sessions-"));
	savedSessionsEnv = process.env[NATIVE_SESSIONS_DIR_ENV];
	process.env[NATIVE_SESSIONS_DIR_ENV] = sessionsRoot;
});

afterEach(() => {
	if (savedSessionsEnv === undefined) delete process.env[NATIVE_SESSIONS_DIR_ENV];
	else process.env[NATIVE_SESSIONS_DIR_ENV] = savedSessionsEnv;
	try {
		chmodSync(sessionsRoot, 0o700);
	} catch {
		// Already removed or never locked.
	}
	for (const dir of [root, outside, sessionsRoot]) rmSync(dir, { recursive: true, force: true });
});

describe("pruneHostImageRoot retention", () => {
	it("keeps the two newest images however old they are", () => {
		makeDir(root, tag(1), 30 * DAY);
		makeDir(root, tag(2), 20 * DAY);
		const report = pruneHostImageRoot({ root, now: NOW, liveExecutables: [] });
		expect(report.deleted).toEqual([]);
		expect(existsSync(join(root, tag(1)))).toBe(true);
		expect(existsSync(join(root, tag(2)))).toBe(true);
	});

	it("keeps an old image that was used 3 days ago", () => {
		makeNewestTwo();
		makeDir(root, tag(3), 3 * DAY);
		pruneHostImageRoot({ root, now: NOW, liveExecutables: [] });
		expect(existsSync(join(root, tag(3)))).toBe(true);
	});

	it("deletes an image unused for over 7 days that is not among the newest and has no sessions", () => {
		makeNewestTwo();
		makeDir(root, tag(3), OLD);
		const report = pruneHostImageRoot({ root, now: NOW, liveExecutables: [] });
		expect(report.deleted).toEqual([tag(3)]);
		expect(existsSync(join(root, tag(3)))).toBe(false);
	});

	it("keeps an image just inside the 7 day window and deletes one just outside it", () => {
		makeNewestTwo();
		makeDir(root, tag(3), KEEP_RECENT_MS - 1000);
		makeDir(root, tag(4), KEEP_RECENT_MS + 1000);
		pruneHostImageRoot({ root, now: NOW, liveExecutables: [] });
		expect(existsSync(join(root, tag(3)))).toBe(true);
		expect(existsSync(join(root, tag(4)))).toBe(false);
	});

	it("keeps an old image a live session runs from", () => {
		makeNewestTwo();
		const dir = makeDir(root, tag(3), OLD);
		pruneHostImageRoot({ root, now: NOW, liveExecutables: [join(dir, "dev3-terminal-host")] });
		expect(existsSync(dir)).toBe(true);
	});

	it("does not mistake a sibling tag sharing a name prefix for the same image", () => {
		makeNewestTwo();
		makeDir(root, tag(3), OLD);
		const sibling = `${tag(3)}-p2-000000000000`;
		makeDir(root, sibling, OLD);
		pruneHostImageRoot({ root, now: NOW, liveExecutables: [join(root, sibling, "dev3-terminal-host")] });
		expect(existsSync(join(root, tag(3)))).toBe(false);
		expect(existsSync(join(root, sibling))).toBe(true);
	});
});

describe("pruneHostImageRoot path matching", () => {
	it("keeps an image reached through a symlinked root when the session names the real path", () => {
		makeNewestTwo();
		const dir = makeDir(root, tag(3), OLD);
		const linkRoot = join(outside, "link-root");
		symlinkSync(root, linkRoot, "dir");
		pruneHostImageRoot({ root: linkRoot, now: NOW, liveExecutables: [join(dir, "dev3-terminal-host")] });
		expect(existsSync(dir)).toBe(true);
	});

	it("keeps an image when the session names the executable through a symlink to the root", () => {
		makeNewestTwo();
		const dir = makeDir(root, tag(3), OLD);
		const linkRoot = join(outside, "link-root");
		symlinkSync(root, linkRoot, "dir");
		pruneHostImageRoot({ root, now: NOW, liveExecutables: [join(linkRoot, tag(3), "dev3-terminal-host")] });
		expect(existsSync(dir)).toBe(true);
	});
});

describe("pruneHostImageRoot only touches what it owns", () => {
	it("leaves foreign names alone", () => {
		makeNewestTwo();
		makeDir(root, "foo", OLD);
		makeDir(root, "notes", OLD);
		writeFileSync(join(root, ".DS_Store"), "x");
		const report = pruneHostImageRoot({ root, now: NOW, liveExecutables: [] });
		expect(report.deleted).toEqual([]);
		expect(report.kept).toBe(2);
		expect(existsSync(join(root, "foo"))).toBe(true);
		expect(existsSync(join(root, "notes"))).toBe(true);
		expect(existsSync(join(root, ".DS_Store"))).toBe(true);
	});

	it("leaves a symlink with a valid tag name and its target untouched", () => {
		makeNewestTwo();
		const target = makeDir(outside, "precious", OLD);
		symlinkSync(target, join(root, tag(3)), "dir");
		const report = pruneHostImageRoot({ root, now: NOW, liveExecutables: [] });
		expect(report.deleted).toEqual([]);
		expect(existsSync(join(target, "dev3-terminal-host"))).toBe(true);
		expect(existsSync(join(root, tag(3)))).toBe(true);
	});

	it("leaves a plain file with a valid tag name alone", () => {
		makeNewestTwo();
		writeFileSync(join(root, tag(3)), "not a directory");
		utimesSync(join(root, tag(3)), new Date(NOW - OLD), new Date(NOW - OLD));
		const report = pruneHostImageRoot({ root, now: NOW, liveExecutables: [] });
		expect(report.deleted).toEqual([]);
		expect(statSync(join(root, tag(3))).isFile()).toBe(true);
	});
});

describe("pruneHostImageRoot scratch directories", () => {
	it("deletes a .staging-* directory older than 24h and keeps a younger one", () => {
		makeDir(root, `.staging-${tag(5)}-AbC123`, STALE_STAGING_MS + 60_000);
		makeDir(root, `.staging-${tag(6)}-XyZ789`, STALE_STAGING_MS - 60_000);
		const report = pruneHostImageRoot({ root, now: NOW, liveExecutables: [] });
		expect(report.deletedStaging).toEqual([`.staging-${tag(5)}-AbC123`]);
		expect(existsSync(join(root, `.staging-${tag(5)}-AbC123`))).toBe(false);
		expect(existsSync(join(root, `.staging-${tag(6)}-XyZ789`))).toBe(true);
	});

	it("leaves a .staging-* symlink alone", () => {
		const target = makeDir(outside, "scratch", OLD);
		symlinkSync(target, join(root, ".staging-link"), "dir");
		const report = pruneHostImageRoot({ root, now: NOW, liveExecutables: [] });
		expect(report.deletedStaging).toEqual([]);
		expect(existsSync(join(target, "dev3-terminal-host"))).toBe(true);
	});
});

describe("pruneHostImageRoot failure handling", () => {
	it("does nothing and does not throw when the root is missing", () => {
		const report = pruneHostImageRoot({ root: join(root, "missing"), now: NOW, liveExecutables: [] });
		expect(report).toEqual({ deleted: [], deletedStaging: [], failed: [], kept: 0 });
	});

	it("reports a failed delete and still prunes the others", () => {
		makeNewestTwo();
		makeDir(root, tag(3), OLD);
		makeDir(root, tag(4), OLD + DAY);
		const report = pruneHostImageRoot({
			root,
			now: NOW,
			liveExecutables: [],
			removeDir: (path) => {
				if (path.endsWith(tag(3))) throw new Error("EBUSY: resource busy");
				rmSync(path, { recursive: true, force: true });
			},
		});
		expect(report.failed).toEqual([{ name: tag(3), error: expect.stringContaining("EBUSY") }]);
		expect(report.deleted).toEqual([tag(4)]);
		expect(existsSync(join(root, tag(3)))).toBe(true);
		expect(existsSync(join(root, tag(4)))).toBe(false);
	});
});

describe("an image is whole or gone", () => {
	it("stops at a runtime carrier that cannot be removed and leaves the rest of the image intact", () => {
		makeNewestTwo();
		const dir = makeDir(root, tag(3), OLD);
		rmSync(join(dir, "dev3-terminal-host"));
		mkdirSync(join(dir, "dev3-terminal-host", "locked"), { recursive: true }); // unlink of a directory fails, like a locked exe
		setAge(dir, OLD); // the edits above refreshed the mtime
		const report = pruneHostImageRoot({ root, now: NOW, liveExecutables: [] });
		expect(report.deleted).toEqual([]);
		expect(report.failed.map((failure) => failure.name)).toEqual([tag(3)]);
		expect(existsSync(join(dir, "host-image.json"))).toBe(true);
		expect(existsSync(join(dir, "dev3-terminal-host.js"))).toBe(true);
	});

	it("deletes an image with its carrier removed even though its mtime is recent", () => {
		makeNewestTwo();
		const dir = makeDir(root, tag(3), 0);
		unlinkSync(join(dir, "dev3-terminal-host"));
		const report = pruneHostImageRoot({ root, now: NOW, liveExecutables: [] });
		expect(report.deleted).toEqual([tag(3)]);
	});

	it.each([
		["a missing manifest", (dir: string) => unlinkSync(join(dir, "host-image.json"))],
		["an unparseable manifest", (dir: string) => writeFileSync(join(dir, "host-image.json"), "{nope")],
		["a missing entrypoint", (dir: string) => unlinkSync(join(dir, "dev3-terminal-host.js"))],
	])("treats %s as an incomplete image and deletes it", (_label, damage) => {
		makeNewestTwo();
		const dir = makeDir(root, tag(3), 0);
		damage(dir);
		expect(pruneHostImageRoot({ root, now: NOW, liveExecutables: [] }).deleted).toEqual([tag(3)]);
	});

	it("does not let incomplete images take a place among the newest two", () => {
		makeDir(root, tag(1), 20 * DAY);
		makeDir(root, tag(2), 30 * DAY);
		const broken = makeDir(root, tag(3), 0);
		unlinkSync(join(broken, "dev3-terminal-host"));
		const report = pruneHostImageRoot({ root, now: NOW, liveExecutables: [] });
		expect(report.deleted).toEqual([tag(3)]);
		expect(existsSync(join(root, tag(1)))).toBe(true);
		expect(existsSync(join(root, tag(2)))).toBe(true);
	});

	it("keeps an incomplete image a live session runs from", () => {
		makeNewestTwo();
		const dir = makeDir(root, tag(3), 0);
		unlinkSync(join(dir, "dev3-terminal-host.js"));
		pruneHostImageRoot({ root, now: NOW, liveExecutables: [join(dir, "dev3-terminal-host")] });
		expect(existsSync(dir)).toBe(true);
	});

	it("removes an image left half-deleted by a failure after the carrier was unlinked", () => {
		makeNewestTwo();
		const dir = makeDir(root, tag(3), OLD);
		const first = pruneHostImageRoot({
			root,
			now: NOW,
			liveExecutables: [],
			removeDir: (path) => {
				unlinkSync(join(path, "dev3-terminal-host"));
				throw new Error("EPERM: operation not permitted");
			},
		});
		expect(first.failed).toHaveLength(1);
		expect(existsSync(dir)).toBe(true);
		expect(existsSync(join(dir, "dev3-terminal-host"))).toBe(false);
		setAge(dir, 0); // the unlink refreshed the mtime, which must not keep the broken image alive
		const second = pruneHostImageRoot({ root, now: NOW, liveExecutables: [] });
		expect(second.deleted).toEqual([tag(3)]);
		expect(existsSync(dir)).toBe(false);
	});

	it("removeImageDirectory takes the carrier first, then the directory", () => {
		const dir = makeDir(root, tag(3), OLD);
		removeImageDirectory(dir);
		expect(existsSync(dir)).toBe(false);
	});
});

describe("a launch refreshing an image mid-prune", () => {
	it("keeps a candidate whose mtime was refreshed by the time its turn comes", () => {
		makeNewestTwo();
		makeDir(root, tag(4), OLD); // processed first: the newer of the two candidates
		const b = makeDir(root, tag(3), OLD + DAY);
		const report = pruneHostImageRoot({
			root,
			now: NOW,
			liveExecutables: [],
			removeDir: (path) => {
				setAge(b, 0); // a launch in this process touches B between the two deletes
				rmSync(path, { recursive: true, force: true });
			},
		});
		expect(report.deleted).toEqual([tag(4)]);
		expect(existsSync(b)).toBe(true);
	});
});

describe("session liveness (real registry reader)", () => {
	const hostExe = (dir: string): string => join(dir, "dev3-terminal-host");

	it("keeps images of owned and reused sessions and deletes the one whose session is dead", async () => {
		makeNewestTwo();
		const owned = makeDir(root, tag(3), OLD);
		const reused = makeDir(root, tag(4), OLD);
		const dead = makeDir(root, tag(5), OLD);
		writeSession("s-owned", hostExe(owned));
		writeSession("s-reused", hostExe(reused));
		writeSession("s-dead", hostExe(dead));
		const report = await pruneHostImages({
			root,
			now: NOW,
			isHostAlive: () => false,
			classify: verdicts({ "s-owned": "owned", "s-reused": "reused", "s-dead": "dead" }),
		});
		expect(report?.deleted).toEqual([tag(5)]);
		expect(existsSync(owned)).toBe(true);
		expect(existsSync(reused)).toBe(true);
	});

	it("protects a dead session's image while its host pid is still alive", async () => {
		makeNewestTwo();
		const alive = makeDir(root, tag(3), OLD);
		const gone = makeDir(root, tag(4), OLD);
		writeSession("s-alive", hostExe(alive), 111);
		writeSession("s-gone", hostExe(gone), 222);
		const report = await pruneHostImages({
			root,
			now: NOW,
			isHostAlive: (pid) => pid === 111,
			classify: verdicts({}),
		});
		expect(report?.deleted).toEqual([tag(4)]);
		expect(existsSync(alive)).toBe(true);
	});

	it("proceeds when the sessions root does not exist", async () => {
		makeNewestTwo();
		makeDir(root, tag(3), OLD);
		rmSync(sessionsRoot, { recursive: true, force: true });
		const report = await pruneHostImages({ root, now: NOW });
		expect(report?.deleted).toEqual([tag(3)]);
	});

	it("ignores a session directory that has no record file", async () => {
		makeNewestTwo();
		makeDir(root, tag(3), OLD);
		mkdirSync(sessionDir("no-record"), { recursive: true });
		const report = await pruneHostImages({ root, now: NOW, classify: verdicts({}), isHostAlive: () => false });
		expect(report?.deleted).toEqual([tag(3)]);
	});

	it("deletes nothing when one record is corrupt", async () => {
		makeNewestTwo();
		const dir = makeDir(root, tag(3), OLD);
		mkdirSync(sessionDir("broken"), { recursive: true });
		writeFileSync(recordFile("broken"), "{not json");
		const report = await pruneHostImages({ root, now: NOW, classify: verdicts({}), isHostAlive: () => false });
		expect(report).toBeNull();
		expect(existsSync(dir)).toBe(true);
	});

	it("deletes nothing when a record has a foreign schema", async () => {
		makeNewestTwo();
		const dir = makeDir(root, tag(3), OLD);
		mkdirSync(sessionDir("future"), { recursive: true });
		writeFileSync(recordFile("future"), JSON.stringify({ schemaVersion: 999 }));
		expect(await pruneHostImages({ root, now: NOW })).toBeNull();
		expect(existsSync(dir)).toBe(true);
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"deletes nothing when the sessions root cannot be read",
		async () => {
			makeNewestTwo();
			const dir = makeDir(root, tag(3), OLD);
			chmodSync(sessionsRoot, 0o000);
			const report = await pruneHostImages({ root, now: NOW });
			expect(report).toBeNull();
			expect(existsSync(dir)).toBe(true);
		},
	);

	it("deletes nothing when classifying a session throws", async () => {
		makeNewestTwo();
		const dir = makeDir(root, tag(3), OLD);
		writeSession("s-any", hostExe(dir));
		const report = await pruneHostImages({
			root,
			now: NOW,
			classify: async () => {
				throw new Error("probe failed");
			},
		});
		expect(report).toBeNull();
		expect(existsSync(dir)).toBe(true);
	});

	it("skips a second prune that starts while one is running", async () => {
		makeNewestTwo();
		makeDir(root, tag(3), OLD);
		writeSession("s-gate", "/elsewhere/dev3-terminal-host");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = pruneHostImages({
			root,
			now: NOW,
			isHostAlive: () => false,
			classify: async () => (await gate, "dead"),
		});
		expect(await pruneHostImages({ root, now: NOW })).toBeNull();
		release();
		expect((await first)?.deleted).toEqual([tag(3)]);
	});
});
