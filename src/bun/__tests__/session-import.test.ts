import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPathInside } from "../conversation-search";
import { listImportableSessions } from "../session-import";
import { claudeEncodePath } from "../../shared/conversation-search-core";

let home: string;
let dev3Home: string;
let project: string;

/** A Claude transcript for `cwd`. `cwd` lives in the records, not the dir name. */
function seedClaude(
	cwd: string,
	sessionId: string,
	options: { title?: string; branch?: string; opening?: string; mtimeSec?: number } = {},
): void {
	const dir = join(home, ".claude", "projects", claudeEncodePath(cwd));
	mkdirSync(dir, { recursive: true });
	const stamp = { cwd, sessionId, gitBranch: options.branch ?? "main", timestamp: "2026-08-26T10:00:00Z" };
	const lines = [
		JSON.stringify({
			type: "user",
			message: { role: "user", content: options.opening ?? "start the thing" },
			uuid: "u1",
			...stamp,
		}),
		JSON.stringify({
			type: "assistant",
			message: { role: "assistant", content: [{ type: "text", text: "on it" }] },
			uuid: "a1",
			...stamp,
		}),
	];
	if (options.title) lines.push(JSON.stringify({ type: "ai-title", aiTitle: options.title, sessionId }));
	const file = join(dir, `${sessionId}.jsonl`);
	writeFileSync(file, lines.join("\n") + "\n");
	if (options.mtimeSec) utimesSync(file, options.mtimeSec, options.mtimeSec);
}

function list(root = project) {
	return listImportableSessions(root, { home, dev3Home });
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "session-import-"));
	dev3Home = join(home, ".dev3.0");
	project = join(home, "code", "my-app");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("isPathInside", () => {
	it("matches the path itself and anything below it", () => {
		expect(isPathInside("/a/b", "/a/b")).toBe(true);
		expect(isPathInside("/a/b/c/d", "/a/b")).toBe(true);
		expect(isPathInside("/a/b/", "/a/b")).toBe(true);
	});

	it("refuses a sibling that merely shares a name prefix", () => {
		// The real near-miss this guards: a project at `…/dev-3.0` must not claim
		// a session that ran in `…/dev-3.0-scratch`.
		expect(isPathInside("/a/dev-3.0-scratch", "/a/dev-3.0")).toBe(false);
	});

	it("refuses the parent of the project", () => {
		// Measured on a real board: the project is `…/playground/dev-3.0` while
		// two sessions ran in `…/playground`. Those belong to no project.
		expect(isPathInside("/a/playground", "/a/playground/dev-3.0")).toBe(false);
	});
});

describe("listImportableSessions", () => {
	it("finds a session by the cwd inside its transcript, not by the directory name", () => {
		seedClaude(project, "s-1", { title: "Wire up billing", branch: "feat/billing" });

		const found = list();

		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({
			source: "claude",
			sessionId: "s-1",
			cwd: project,
			title: "Wire up billing",
			gitBranch: "feat/billing",
		});
	});

	it("includes sessions started in a subdirectory of the project", () => {
		seedClaude(join(project, "packages", "api"), "s-sub");

		expect(list().map((s) => s.sessionId)).toEqual(["s-sub"]);
	});

	it("excludes sessions belonging to a different project", () => {
		seedClaude(join(home, "code", "other-app"), "s-other");
		seedClaude(project, "s-mine");

		expect(list().map((s) => s.sessionId)).toEqual(["s-mine"]);
	});

	it("excludes a sibling directory that shares a name prefix", () => {
		seedClaude(`${project}-scratch`, "s-scratch");

		expect(list()).toEqual([]);
	});

	it("excludes sessions that already ran inside a dev3 worktree", () => {
		// Those are dev3 tasks already; importing one would duplicate it.
		seedClaude(join(dev3Home, "worktrees", "slug", "abcd1234", "worktree"), "s-task");
		seedClaude(project, "s-outside");

		expect(list().map((s) => s.sessionId)).toEqual(["s-outside"]);
	});

	it("excludes session ids the caller says are already claimed", () => {
		seedClaude(project, "s-taken");
		seedClaude(project, "s-free");

		const found = listImportableSessions(project, { home, dev3Home, excludeSessionIds: ["s-taken"] });

		expect(found.map((s) => s.sessionId)).toEqual(["s-free"]);
	});

	it("orders newest first", () => {
		seedClaude(project, "s-old", { mtimeSec: 1_600_000_000 });
		seedClaude(project, "s-new", { mtimeSec: 1_800_000_000 });

		expect(list().map((s) => s.sessionId)).toEqual(["s-new", "s-old"]);
	});

	it("reports no title rather than failing when the agent never wrote one", () => {
		// Codex records none at all, and a Claude session younger than its first
		// assistant turn has none yet. The row still has to render.
		seedClaude(project, "s-untitled", { opening: "look at the flaky test" });

		const [session] = list();
		expect(session.title).toBeNull();
		expect(session.sessionId).toBe("s-untitled");
	});

	it("returns nothing when the project has no sessions", () => {
		expect(list()).toEqual([]);
	});
});
