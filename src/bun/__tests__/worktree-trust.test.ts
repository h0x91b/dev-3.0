import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// worktree-trust.ts derives ~/.gemini and the worktrees root from process.env.HOME
// (via paths.ts) at import time, so HOME must point at a tmp dir BEFORE the import.
let forgetWorktreeTrust: typeof import("../worktree-trust").forgetWorktreeTrust;
let sweepStaleWorktreeTrust: typeof import("../worktree-trust").sweepStaleWorktreeTrust;
let TRUST_FILE: string;

let tmpHome: string;
let originalHome: string | undefined;
let worktreesRoot: string;

function writeTrust(data: Record<string, string>): void {
	writeFileSync(TRUST_FILE, JSON.stringify(data, null, 2));
}

function readTrust(): Record<string, string> {
	return JSON.parse(readFileSync(TRUST_FILE, "utf-8"));
}

/** Create `<worktreesRoot>/<slug>/<taskId>/worktree` and return its path. */
function makeWorktree(taskId: string): string {
	const path = join(worktreesRoot, "some-project", taskId, "worktree");
	mkdirSync(path, { recursive: true });
	return path;
}

function deadWorktreePath(taskId: string): string {
	return join(worktreesRoot, "some-project", taskId, "worktree");
}

beforeAll(async () => {
	originalHome = process.env.HOME;
	tmpHome = mkdtempSync(join(tmpdir(), "dev3-trust-"));
	process.env.HOME = tmpHome;
	worktreesRoot = join(tmpHome, ".dev3.0", "worktrees");
	mkdirSync(join(tmpHome, ".gemini"), { recursive: true });
	const mod = await import("../worktree-trust");
	forgetWorktreeTrust = mod.forgetWorktreeTrust;
	sweepStaleWorktreeTrust = mod.sweepStaleWorktreeTrust;
	TRUST_FILE = mod.GEMINI_TRUSTED_FOLDERS;
});

afterAll(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
	rmSync(worktreesRoot, { recursive: true, force: true });
	rmSync(TRUST_FILE, { force: true });
});

describe("forgetWorktreeTrust", () => {
	it("removes the entry for the worktree that was just deleted", async () => {
		const gone = deadWorktreePath("aaaa1111");
		const alive = makeWorktree("bbbb2222");
		writeTrust({ [gone]: "TRUST_FOLDER", [alive]: "TRUST_FOLDER" });

		await forgetWorktreeTrust(gone);

		expect(readTrust()).toEqual({ [alive]: "TRUST_FOLDER" });
	});

	it("matches a key that differs only in case or separators", async () => {
		const path = deadWorktreePath("cccc3333");
		writeTrust({ [path.toUpperCase().replaceAll("/", "\\")]: "TRUST_FOLDER" });

		await forgetWorktreeTrust(path);

		expect(readTrust()).toEqual({});
	});

	it("never touches a path outside the dev3 worktrees root", async () => {
		const ownProject = join(tmpHome, "Desktop", "my-project");
		writeTrust({ [ownProject]: "TRUST_FOLDER" });

		await forgetWorktreeTrust(ownProject);

		expect(readTrust()).toEqual({ [ownProject]: "TRUST_FOLDER" });
	});

	it("is a no-op without a worktree path, and when the file is absent", async () => {
		await forgetWorktreeTrust(null);
		await forgetWorktreeTrust(deadWorktreePath("dddd4444"));
		expect(() => readFileSync(TRUST_FILE, "utf-8")).toThrow();
	});
});

describe("sweepStaleWorktreeTrust", () => {
	it("drops dev3 worktree entries whose directory is gone, keeping live ones", async () => {
		const alive = makeWorktree("eeee5555");
		const ownProject = join(tmpHome, "Desktop", "my-project");
		mkdirSync(ownProject, { recursive: true });
		writeTrust({
			[ownProject]: "TRUST_FOLDER",
			[alive]: "TRUST_FOLDER",
			[deadWorktreePath("ffff6666")]: "TRUST_FOLDER",
			[deadWorktreePath("7777aaaa")]: "DO_NOT_TRUST",
		});

		sweepStaleWorktreeTrust();

		expect(readTrust()).toEqual({ [ownProject]: "TRUST_FOLDER", [alive]: "TRUST_FOLDER" });
	});

	it("keeps a user's own missing folder — outside the worktrees root is never swept", async () => {
		const missingOwnFolder = join(tmpHome, "Desktop", "deleted-project");
		writeTrust({ [missingOwnFolder]: "TRUST_FOLDER" });

		sweepStaleWorktreeTrust();

		expect(readTrust()).toEqual({ [missingOwnFolder]: "TRUST_FOLDER" });
	});

	it("leaves an unparsable file untouched (fails closed)", async () => {
		writeFileSync(TRUST_FILE, "{ not json");

		sweepStaleWorktreeTrust();

		expect(readFileSync(TRUST_FILE, "utf-8")).toBe("{ not json");
	});

	it("does not rewrite the file when nothing is stale", async () => {
		const alive = makeWorktree("8888bbbb");
		const raw = `{"${alive}":"TRUST_FOLDER"}`;
		writeFileSync(TRUST_FILE, raw);

		sweepStaleWorktreeTrust();

		expect(readFileSync(TRUST_FILE, "utf-8")).toBe(raw);
	});
});
