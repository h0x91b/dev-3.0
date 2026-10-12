import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listResumableSessionIds, resolveResumableSessionIds } from "../agent-transcripts";
import { claudeEncodePath } from "../../shared/conversation-search-core";

const WORKTREE = "/Users/dev/.dev3.0/ops/operations/7d8312c0/work";

let home: string;

function transcriptDir(): string {
	return join(home, ".claude", "projects", claudeEncodePath(WORKTREE));
}

/** Seed a claude transcript; `ageSeconds` back-dates it so ordering is explicit. */
function seedTranscript(sessionId: string, ageSeconds: number): void {
	const dir = transcriptDir();
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${sessionId}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "assistant", sessionId })}\n`);
	const when = new Date(Date.UTC(2026, 6, 27) - ageSeconds * 1000);
	utimesSync(file, when, when);
}

/** Seed a transcript for an arbitrary working directory — a conversation's origin store. */
function seedTranscriptFor(cwd: string, sessionId: string): void {
	const dir = join(home, ".claude", "projects", claudeEncodePath(cwd));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify({ type: "assistant", cwd, sessionId })}\n`);
}

/**
 * The worktree's own store as a pane resumed from elsewhere really finds it: the
 * directory EXISTS (the agent creates it on resume) but holds no transcript,
 * because the conversation stayed in the origin's store.
 */
function seedEmptyWorktreeStore(): void {
	mkdirSync(join(transcriptDir(), "memory"), { recursive: true });
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "agent-transcripts-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/** Resolve a single pane — the one-pane task every older caller had. */
function resolveOne(agentCmd: string, sessionId: string | null, originCwd?: string) {
	return resolveResumableSessionIds(WORKTREE, [{ agentCmd, sessionId, sessionOriginCwd: originCwd }], home)[0];
}

function claudePanes(...sessionIds: (string | null)[]) {
	return sessionIds.map((sessionId) => ({ agentCmd: "claude", sessionId }));
}

describe("resolveResumableSessionIds — one pane", () => {
	it("keeps a stored id that still has a transcript", () => {
		seedTranscript("1160218f-85f5-4a45-8032-ced3af5a532b", 0);

		expect(resolveOne("claude", "1160218f-85f5-4a45-8032-ced3af5a532b")).toEqual({
			sessionId: "1160218f-85f5-4a45-8032-ced3af5a532b",
			substituted: false,
			startFresh: false,
			verified: true,
		});
	});

	it("substitutes the newest transcript when the stored id has none", () => {
		// The real failure: dev3 persisted the live runtime id, but the agent kept
		// appending to the conversation it was resumed from.
		seedTranscript("1160218f-85f5-4a45-8032-ced3af5a532b", 0);
		seedTranscript("aefa0626-853c-49c9-97bf-bd0e88ed89e7", 3600);

		expect(resolveOne("claude", "125a4c8c-b567-4d24-991b-8732e82878c8")).toEqual({
			sessionId: "1160218f-85f5-4a45-8032-ced3af5a532b",
			substituted: true,
			startFresh: false,
			verified: true,
		});
	});

	it("has nothing to resume when the store holds no transcripts", () => {
		mkdirSync(transcriptDir(), { recursive: true });

		expect(resolveOne("claude", "125a4c8c-b567-4d24-991b-8732e82878c8")).toEqual({
			sessionId: null,
			substituted: true,
			startFresh: true,
			verified: false,
		});
	});

	it("passes the stored id through untouched when the store dir does not exist", () => {
		// Unverifiable — a missing dir must never downgrade a resume that would work.
		expect(resolveOne("claude", "125a4c8c-b567-4d24-991b-8732e82878c8")).toEqual({
			sessionId: "125a4c8c-b567-4d24-991b-8732e82878c8",
			substituted: false,
			startFresh: false,
			verified: false,
		});
	});

	it("passes the stored id through for agents with no filename-keyed store", () => {
		seedTranscript("1160218f-85f5-4a45-8032-ced3af5a532b", 0);

		expect(resolveOne("codex", "some-codex-session")).toEqual({
			sessionId: "some-codex-session",
			substituted: false,
			startFresh: false,
			verified: false,
		});
	});

	it("gives a pane with no stored id the newest transcript, as the agent's own latest would", () => {
		seedTranscript("1160218f-85f5-4a45-8032-ced3af5a532b", 0);

		// Verified, unlike the `--continue` this replaces: the transcript was read off disk.
		expect(resolveOne("claude", null)).toEqual({
			sessionId: "1160218f-85f5-4a45-8032-ced3af5a532b",
			substituted: false,
			startFresh: false,
			verified: true,
		});
	});

	it("keeps an id whose conversation lives in the origin store", () => {
		// Without the origin lookup the empty-but-present worktree store yields
		// null, which becomes `--continue`, which starts a BRAND NEW conversation
		// and silently orphans the one the pane was resuming.
		const origin = "/Users/dev/code/my-app";
		seedEmptyWorktreeStore();
		seedTranscriptFor(origin, "elsewhere-1");

		expect(resolveOne("claude", "elsewhere-1", origin)).toEqual({ sessionId: "elsewhere-1", substituted: false, startFresh: false, verified: true });
	});

	it("does not let a later local session hijack an id from the origin store", () => {
		const origin = "/Users/dev/code/my-app";
		seedTranscript("local-session", 10);
		seedTranscriptFor(origin, "elsewhere-1");

		expect(resolveOne("claude", "elsewhere-1", origin)).toEqual({ sessionId: "elsewhere-1", substituted: false, startFresh: false, verified: true });
	});

	it("still heals when the origin store has lost the conversation too", () => {
		seedTranscript("survivor", 10);
		seedEmptyWorktreeStore();

		expect(resolveOne("claude", "gone", "/Users/dev/code/my-app")).toEqual({ sessionId: "survivor", substituted: true, startFresh: false, verified: true });
	});
});

describe("resolveResumableSessionIds — several panes (#1950)", () => {
	it("never hands two stale panes the same newest transcript", () => {
		// Healing each pane on its own gave both stale panes "newest", so they
		// reopened one conversation side by side.
		seedTranscript("pane-a", 30);
		seedTranscript("newest", 0);
		seedTranscript("older", 600);

		const ids = resolveResumableSessionIds(WORKTREE, claudePanes("pane-a", "dead-1", "dead-2"), home).map((t) => t.sessionId);

		expect(ids).toEqual(["pane-a", "newest", "older"]);
	});

	it("lets a pane keep its own conversation even when it is not the newest one", () => {
		seedTranscript("pane-a", 0);
		seedTranscript("pane-b", 600);

		const targets = resolveResumableSessionIds(WORKTREE, claudePanes("dead", "pane-b"), home);

		// The stale main pane must not take pane-b's conversation just because it comes first.
		expect(targets.map((t) => t.sessionId)).toEqual(["pane-a", "pane-b"]);
		expect(targets[1].substituted).toBe(false);
	});

	it("starts a pane fresh when every transcript already belongs to another pane", () => {
		seedTranscript("pane-a", 0);
		seedTranscript("pane-b", 10);

		const targets = resolveResumableSessionIds(WORKTREE, claudePanes("pane-a", "pane-b", "never-prompted"), home);

		expect(targets[2]).toEqual({ sessionId: null, substituted: true, startFresh: true, verified: false });
	});

	it("splits panes that already collapsed onto one id", () => {
		// The old bug persisted the shared id, so both panes now point at one live transcript.
		seedTranscript("shared", 0);
		seedTranscript("pane-b-real", 60);

		const ids = resolveResumableSessionIds(WORKTREE, claudePanes("shared", "shared"), home).map((t) => t.sessionId);

		expect(ids).toEqual(["shared", "pane-b-real"]);
	});

	it("leaves panes of an unverifiable agent out of the claims", () => {
		seedTranscript("pane-a", 0);

		const targets = resolveResumableSessionIds(WORKTREE, [
			{ agentCmd: "codex", sessionId: "codex-rollout" },
			{ agentCmd: "claude", sessionId: "pane-a" },
		], home);

		expect(targets.map((t) => t.sessionId)).toEqual(["codex-rollout", "pane-a"]);
	});
});

describe("listResumableSessionIds", () => {
	it("returns session ids newest first and ignores non-transcript files", () => {
		seedTranscript("aaaaaaaa-0000-0000-0000-000000000001", 7200);
		seedTranscript("bbbbbbbb-0000-0000-0000-000000000002", 60);
		seedTranscript("cccccccc-0000-0000-0000-000000000003", 3600);
		writeFileSync(join(transcriptDir(), "notes.txt"), "ignore me");
		writeFileSync(join(transcriptDir(), ".jsonl"), "no id");

		expect(listResumableSessionIds("claude", WORKTREE, home)).toEqual([
			"bbbbbbbb-0000-0000-0000-000000000002",
			"cccccccc-0000-0000-0000-000000000003",
			"aaaaaaaa-0000-0000-0000-000000000001",
		]);
	});

	it("returns nothing for an agent without a filename-keyed store", () => {
		seedTranscript("aaaaaaaa-0000-0000-0000-000000000001", 0);

		expect(listResumableSessionIds("codex", WORKTREE, home)).toEqual([]);
	});
});
