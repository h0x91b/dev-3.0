import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	conversationDumpDir,
	conversationDumpName,
	parseTranscriptFile,
	parseWorktreeConversations,
	taskContainerDir,
	writeConversationDump,
} from "../conversation-parse";
import { claudeEncodePath } from "../../shared/conversation-search-core";
import { conversationEvents, type ParsedConversation } from "../../shared/conversation-model";

const SLUG = "Users-me-src-proj";
const SHORT_ID = "5ddc7663";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "conv-parse-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function claudeLine(text: string): string {
	return JSON.stringify({
		type: "assistant",
		uuid: "a1",
		sessionId: "sess-9",
		timestamp: "2026-08-17T10:00:00.000Z",
		message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text }] },
	});
}

describe("dump layout", () => {
	it("puts a task's conversations beside its logs and diffs, not in a shared root", () => {
		const container = taskContainerDir(`${home}/.dev3.0`, SLUG, SHORT_ID);
		expect(container).toBe(`${home}/.dev3.0/worktrees/${SLUG}/${SHORT_ID}`);
		// The sibling of worktree/ — so it outlives worktree teardown.
		expect(conversationDumpDir(container)).toBe(`${container}/conversations`);
	});

	it("names a dump by agent and session, so one task holds many of them", () => {
		const base = { source: "claude", sessionId: "sess-1" } as ParsedConversation;
		expect(conversationDumpName(base)).toBe("claude-sess-1.json");
		expect(conversationDumpName({ ...base, source: "codex", sessionId: "roll-2" })).toBe("codex-roll-2.json");
	});

	it("falls back to a stable name when the transcript has no session id", () => {
		expect(conversationDumpName({ source: "codex", sessionId: null } as ParsedConversation)).toBe("codex-no-session.json");
	});

	it("creates the directory and writes readable JSON", async () => {
		const dir = conversationDumpDir(taskContainerDir(`${home}/.dev3.0`, SLUG, SHORT_ID));
		const conversation = { source: "claude", sessionId: "sess-1", turns: [], sessionEvents: [] } as unknown as ParsedConversation;
		const path = await writeConversationDump(dir, conversationDumpName(conversation), conversation);

		expect(existsSync(path)).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf-8"))).toMatchObject({ sessionId: "sess-1" });
	});
});

describe("parseWorktreeConversations", () => {
	function seedClaudeTranscript(worktreePath: string, name: string, text: string): void {
		const dir = join(home, ".claude", "projects", claudeEncodePath(worktreePath));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, name), `${claudeLine(text)}\n`);
	}

	it("finds the transcripts of the given worktree path", () => {
		const worktree = `${taskContainerDir(`${home}/.dev3.0`, SLUG, SHORT_ID)}/worktree`;
		seedClaudeTranscript(worktree, "sess-9.jsonl", "hello there");

		const parsed = parseWorktreeConversations(worktree, { home });
		expect(parsed).toHaveLength(1);
		expect(parsed[0].conversation.source).toBe("claude");
		expect(conversationEvents(parsed[0].conversation)[0].text).toBe("hello there");
	});

	it("returns nothing for a worktree with no transcripts", () => {
		expect(parseWorktreeConversations(`${home}/.dev3.0/worktrees/${SLUG}/other/worktree`, { home })).toEqual([]);
	});
});

describe("parseTranscriptFile", () => {
	it("sniffs the format when the caller does not name it", () => {
		const path = join(home, "loose.jsonl");
		writeFileSync(path, `${claudeLine("sniff me")}\n`);
		expect(parseTranscriptFile(path)?.source).toBe("claude");
	});

	it("returns null for an unreadable path instead of throwing", () => {
		expect(parseTranscriptFile(join(home, "nope.jsonl"))).toBeNull();
	});

	it("returns null when the content is not a transcript", () => {
		const path = join(home, "other.jsonl");
		writeFileSync(path, '{"hello":"world"}\n');
		expect(parseTranscriptFile(path)).toBeNull();
	});
});
