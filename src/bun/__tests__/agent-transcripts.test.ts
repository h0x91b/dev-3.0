import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listResumableSessionIds, resolveResumableSessionId } from "../agent-transcripts";
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

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "agent-transcripts-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("resolveResumableSessionId", () => {
	it("keeps a stored id that still has a transcript", () => {
		seedTranscript("1160218f-85f5-4a45-8032-ced3af5a532b", 0);

		expect(resolveResumableSessionId("claude", WORKTREE, "1160218f-85f5-4a45-8032-ced3af5a532b", home)).toEqual({
			sessionId: "1160218f-85f5-4a45-8032-ced3af5a532b",
			substituted: false,
		});
	});

	it("substitutes the newest transcript when the stored id has none", () => {
		// The real failure: dev3 persisted the live runtime id, but the agent kept
		// appending to the conversation it was resumed from.
		seedTranscript("1160218f-85f5-4a45-8032-ced3af5a532b", 0);
		seedTranscript("aefa0626-853c-49c9-97bf-bd0e88ed89e7", 3600);

		expect(resolveResumableSessionId("claude", WORKTREE, "125a4c8c-b567-4d24-991b-8732e82878c8", home)).toEqual({
			sessionId: "1160218f-85f5-4a45-8032-ced3af5a532b",
			substituted: true,
		});
	});

	it("drops a dead id to agent-latest when the store holds no transcripts", () => {
		mkdirSync(transcriptDir(), { recursive: true });

		expect(resolveResumableSessionId("claude", WORKTREE, "125a4c8c-b567-4d24-991b-8732e82878c8", home)).toEqual({
			sessionId: null,
			substituted: true,
		});
	});

	it("passes the stored id through untouched when the store dir does not exist", () => {
		// Unverifiable — a missing dir must never downgrade a resume that would work.
		expect(resolveResumableSessionId("claude", WORKTREE, "125a4c8c-b567-4d24-991b-8732e82878c8", home)).toEqual({
			sessionId: "125a4c8c-b567-4d24-991b-8732e82878c8",
			substituted: false,
		});
	});

	it("passes the stored id through for agents with no filename-keyed store", () => {
		seedTranscript("1160218f-85f5-4a45-8032-ced3af5a532b", 0);

		expect(resolveResumableSessionId("codex", WORKTREE, "some-codex-session", home)).toEqual({
			sessionId: "some-codex-session",
			substituted: false,
		});
	});

	it("leaves a null stored id alone so the agent picks its own latest", () => {
		seedTranscript("1160218f-85f5-4a45-8032-ced3af5a532b", 0);

		expect(resolveResumableSessionId("claude", WORKTREE, null, home)).toEqual({
			sessionId: null,
			substituted: false,
		});
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
