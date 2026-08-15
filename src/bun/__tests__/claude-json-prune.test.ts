import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetClaudeTrustEntries, sweepStaleClaudeTrustEntries } from "../claude-json-prune";

let dir: string;
let file: string;
const ROOT = "/home/u/.dev3.0/worktrees";
const live = `${ROOT}/proj/aaaaaaaa/worktree`;
const dead = `${ROOT}/proj/bbbbbbbb/worktree`;
const deadToo = `${ROOT}/proj/cccccccc/worktree`;

/** The same shapes `worktree-trust.ts` passes in. */
const normalize = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
const isUnderRoot = (p: string) => normalize(p).startsWith(`${normalize(ROOT)}/`);

function write(data: unknown): void {
	writeFileSync(file, JSON.stringify(data, null, 2));
}

function sweepOpts(overrides: Record<string, unknown> = {}) {
	return { files: [file], exists: (p: string) => p === live, ...overrides };
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dev3-prune-"));
	file = join(dir, ".claude.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("sweepStaleClaudeTrustEntries", () => {
	it("removes only dev3 entries whose directory is gone", () => {
		write({
			projects: {
				[live]: { hasTrustDialogAccepted: true },
				[dead]: { hasTrustDialogAccepted: true },
				[deadToo]: { hasTrustDialogAccepted: true },
				"/home/u/code/app": { hasTrustDialogAccepted: true },
			},
		});

		expect(sweepStaleClaudeTrustEntries(isUnderRoot, sweepOpts())).toEqual([
			{ file, removed: 2, skipped: null },
		]);
		expect(Object.keys(JSON.parse(readFileSync(file, "utf-8")).projects)).toEqual([live, "/home/u/code/app"]);
	});

	it("never touches a non-dev3 entry, even when its directory is gone", () => {
		write({ projects: { "/home/u/deleted-repo": { hasTrustDialogAccepted: true } } });

		expect(sweepStaleClaudeTrustEntries(isUnderRoot, sweepOpts())[0]!.removed).toBe(0);
		expect(JSON.parse(readFileSync(file, "utf-8")).projects["/home/u/deleted-repo"]).toBeTruthy();
	});

	it("preserves unknown top-level keys and unknown fields of surviving entries", () => {
		write({
			numStartups: 42,
			oauthAccount: { emailAddress: "a@b.c" },
			projects: {
				[live]: { hasTrustDialogAccepted: true, history: [{ display: "hi" }], mcpServers: { x: 1 } },
				[dead]: { hasTrustDialogAccepted: true },
			},
		});

		sweepStaleClaudeTrustEntries(isUnderRoot, sweepOpts());

		const after = JSON.parse(readFileSync(file, "utf-8"));
		expect(after.numStartups).toBe(42);
		expect(after.oauthAccount).toEqual({ emailAddress: "a@b.c" });
		expect(after.projects[live]).toEqual({
			hasTrustDialogAccepted: true,
			history: [{ display: "hi" }],
			mcpServers: { x: 1 },
		});
	});

	it("leaves an unparsable file byte-identical", () => {
		const broken = '{"projects": {"a": ';
		writeFileSync(file, broken);

		expect(sweepStaleClaudeTrustEntries(isUnderRoot, sweepOpts())).toEqual([
			{ file, removed: 0, skipped: "unparsable" },
		]);
		expect(readFileSync(file, "utf-8")).toBe(broken);
	});

	it("reports an absent file without creating it", () => {
		const missing = join(dir, "nope.json");
		expect(sweepStaleClaudeTrustEntries(isUnderRoot, sweepOpts({ files: [missing] }))).toEqual([
			{ file: missing, removed: 0, skipped: "absent" },
		]);
	});

	it("is a no-op when the file has no projects map", () => {
		write({ numStartups: 1 });

		expect(sweepStaleClaudeTrustEntries(isUnderRoot, sweepOpts())[0]!.skipped).toBeNull();
		expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ numStartups: 1 });
	});

	it("does not rewrite the file when there is nothing to prune", () => {
		write({ projects: { [live]: { hasTrustDialogAccepted: true } } });
		const before = statSync(file).mtimeMs;

		expect(sweepStaleClaudeTrustEntries(isUnderRoot, sweepOpts())[0]!.removed).toBe(0);
		expect(statSync(file).mtimeMs).toBe(before);
	});

	it("keeps a concurrent Claude Code write instead of clobbering it", () => {
		write({ projects: { [live]: { hasTrustDialogAccepted: true }, [dead]: { hasTrustDialogAccepted: true } } });
		let calls = 0;
		// Simulate Claude Code rewriting the file between our read and our rename,
		// on every attempt, by touching it while we probe for existence.
		const exists = (p: string) => {
			calls++;
			utimesSync(file, new Date(), new Date(Date.now() + calls * 1000));
			return p === live;
		};

		expect(sweepStaleClaudeTrustEntries(isUnderRoot, sweepOpts({ exists }))).toEqual([
			{ file, removed: 0, skipped: "busy" },
		]);
		expect(JSON.parse(readFileSync(file, "utf-8")).projects[dead]).toBeTruthy();
	});

	it("sweeps every listed file", () => {
		const second = join(dir, "account.claude.json");
		write({ projects: { [dead]: {} } });
		writeFileSync(second, JSON.stringify({ projects: { [dead]: {}, [live]: {} } }, null, 2));

		const results = sweepStaleClaudeTrustEntries(isUnderRoot, sweepOpts({ files: [file, second] }));

		expect(results.map((r) => r.removed)).toEqual([1, 1]);
		expect(JSON.parse(readFileSync(second, "utf-8")).projects).toEqual({ [live]: {} });
	});
});

describe("forgetClaudeTrustEntries", () => {
	it("removes exactly the removed worktree, existence notwithstanding", () => {
		write({ projects: { [live]: {}, [dead]: {}, [deadToo]: {} } });

		const results = forgetClaudeTrustEntries([normalize(live)], normalize, { files: [file] });

		expect(results[0]!.removed).toBe(1);
		expect(Object.keys(JSON.parse(readFileSync(file, "utf-8")).projects)).toEqual([dead, deadToo]);
	});

	it("matches a key that differs only in case or trailing slash", () => {
		write({ projects: { [`${dead.toUpperCase()}/`]: {} } });

		expect(forgetClaudeTrustEntries([normalize(dead)], normalize, { files: [file] })[0]!.removed).toBe(1);
		expect(JSON.parse(readFileSync(file, "utf-8")).projects).toEqual({});
	});

	it("does nothing when the caller has no targets", () => {
		write({ projects: { [dead]: {} } });

		expect(forgetClaudeTrustEntries([], normalize, { files: [file] })).toEqual([]);
		expect(JSON.parse(readFileSync(file, "utf-8")).projects[dead]).toBeTruthy();
	});
});
