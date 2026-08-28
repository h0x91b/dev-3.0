/**
 * Discovery for the conversation import: which Claude Code conversations a
 * project is offered, and which it must never be offered.
 *
 * Every case builds a temporary home with hand-written JSONL — nothing here may
 * depend on the developer's own `~/.claude`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeEncodePath } from "../../shared/conversation-search-core";
import { classifyClaudeTranscript, scanImportableConversations } from "../conversation-import";

let home: string;
let project: string;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);

interface SeedOptions {
	/** Config dir the store lives under. Defaults to the home store. */
	configDir?: string;
	/** Directory the session ran in — encoded into the store name. */
	workingDir?: string;
	title?: string | null;
	cwd?: string | null;
	gitBranch?: string | null;
	prompts?: string[];
	sidechain?: boolean;
	teammate?: boolean;
	ageDays?: number;
}

function seedConversation(sessionId: string, options: SeedOptions = {}): string {
	const configDir = options.configDir ?? join(home, ".claude");
	const workingDir = options.workingDir ?? project;
	const dir = join(configDir, "projects", claudeEncodePath(workingDir));
	mkdirSync(dir, { recursive: true });

	const records: Record<string, unknown>[] = [
		{ type: "mode", sessionId, uuid: "u0" },
		...(options.teammate ? [{ type: "agent-setting", sessionId, uuid: "u-agent" }] : []),
		...(options.title === null ? [] : [{ type: "ai-title", aiTitle: options.title ?? `Title of ${sessionId}`, sessionId }]),
		...(options.prompts ?? ["Make the thing work"]).map((text, i) => ({
			type: "user",
			sessionId,
			uuid: `u${i + 1}`,
			timestamp: "2026-08-20T10:00:00.000Z",
			...(options.cwd === null ? {} : { cwd: options.cwd ?? workingDir }),
			...(options.gitBranch ? { gitBranch: options.gitBranch } : {}),
			...(options.sidechain ? { isSidechain: true } : {}),
			message: { role: "user", content: [{ type: "text", text }] },
		})),
		// A tool result also arrives as a `user` record and must not count as a turn.
		{
			type: "user",
			sessionId,
			uuid: "u-tool",
			message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] },
		},
	];

	const file = join(dir, `${sessionId}.jsonl`);
	writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
	if (options.ageDays !== undefined) {
		const when = (NOW - options.ageDays * DAY_MS) / 1000;
		utimesSync(file, when, when);
	}
	return file;
}

function scan(over: Partial<Parameters<typeof scanImportableConversations>[0]> = {}) {
	return scanImportableConversations({ projectPath: project, home, nowMs: NOW, ...over });
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "convimport-"));
	project = join(home, "code", "dev-3.0");
	mkdirSync(project, { recursive: true });
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("classifyClaudeTranscript", () => {
	it("names a titled main conversation, its branch and its turns", () => {
		const file = seedConversation("s1", { title: "Fix the parser", gitBranch: "feat/x", prompts: ["one", "two"] });
		const classified = classifyClaudeTranscript(readFileSync(file, "utf-8"));
		expect(classified).toMatchObject({ kind: "main", title: "Fix the parser", gitBranch: "feat/x", turns: 2 });
	});

	it("calls a sidechain file a subagent run, whatever its first record was", () => {
		const file = seedConversation("s2", { sidechain: true });
		expect(classifyClaudeTranscript(readFileSync(file, "utf-8")).kind).toBe("subagent");
	});

	it("calls a file with an agent-setting record a teammate run", () => {
		const file = seedConversation("s3", { teammate: true });
		expect(classifyClaudeTranscript(readFileSync(file, "utf-8")).kind).toBe("teammate");
	});

	it("refuses to name a conversation Claude never titled", () => {
		const file = seedConversation("s4", { title: null });
		expect(classifyClaudeTranscript(readFileSync(file, "utf-8")).kind).toBe("untitled");
	});
});

describe("scanImportableConversations", () => {
	it("offers a titled conversation that ran in the project", () => {
		seedConversation("s1", { title: "Fix the parser", gitBranch: "feat/x", ageDays: 1 });
		expect(scan()).toMatchObject([{
			sessionId: "s1",
			title: "Fix the parser",
			workingDir: project,
			gitBranch: "feat/x",
			turns: 1,
			targetStatus: "user-questions",
		}]);
	});

	it("files work from the last week into Has Questions and older work into Completed", () => {
		seedConversation("recent", { ageDays: 3 });
		seedConversation("old", { ageDays: 40 });
		const byId = new Map(scan().map((c) => [c.sessionId, c.targetStatus]));
		expect(byId.get("recent")).toBe("user-questions");
		expect(byId.get("old")).toBe("completed");
	});

	it("offers nothing for subagent, teammate or untitled transcripts", () => {
		seedConversation("sub", { sidechain: true });
		seedConversation("team", { teammate: true });
		seedConversation("bare", { title: null });
		expect(scan()).toEqual([]);
	});

	it("never offers a conversation that ran inside a dev3 worktree", () => {
		const worktree = join(home, ".dev3.0", "worktrees", "code-dev-3-0", "abcd1234", "worktree");
		mkdirSync(worktree, { recursive: true });
		seedConversation("inside-dev3", { workingDir: worktree, cwd: worktree });
		// Even asked about the dev3 path directly, which no project may ever be.
		expect(scanImportableConversations({ projectPath: worktree, home, nowMs: NOW })).toEqual([]);
		expect(scan()).toEqual([]);
	});

	it("never offers a conversation from a redirected instance's worktrees either", () => {
		// A `--qa` board keeps its worktrees under its own DEV3_HOME, which is not
		// `~/.dev3.0` at all — its own work must stay just as invisible.
		const scoped = join(home, "qa-root");
		const worktree = join(scoped, "worktrees", "code-dev-3-0", "abcd1234", "worktree");
		mkdirSync(worktree, { recursive: true });
		seedConversation("inside-qa", { workingDir: worktree, cwd: worktree });
		expect(scan({ dev3Home: scoped })).toEqual([]);
	});

	it("does not let a project claim a sibling whose name merely starts the same", () => {
		const sibling = join(home, "code", "dev-3.0-scratch");
		mkdirSync(sibling, { recursive: true });
		seedConversation("sibling", { workingDir: sibling, cwd: sibling });
		expect(scan()).toEqual([]);
	});

	it("offers a session that ran in a subdirectory of the project", () => {
		const sub = join(project, "packages", "cli");
		mkdirSync(sub, { recursive: true });
		seedConversation("deep", { workingDir: sub, cwd: sub });
		expect(scan()).toMatchObject([{ sessionId: "deep", workingDir: sub }]);
	});

	it("skips a subdirectory session whose working directory is gone", () => {
		const gone = join(project, "deleted-worktree");
		seedConversation("vanished", { workingDir: gone, cwd: gone });
		expect(scan()).toEqual([]);
	});

	it("skips a subdirectory session whose records never recorded a cwd", () => {
		const sub = join(project, "packages", "web");
		mkdirSync(sub, { recursive: true });
		seedConversation("nocwd", { workingDir: sub, cwd: null });
		expect(scan()).toEqual([]);
	});

	it("finds a conversation that ran under a dev3 agent account", () => {
		const account = join(home, ".dev3.0", "agent-accounts", "claude", "acc-1");
		seedConversation("second-account", { configDir: account, title: "Work from another login" });
		expect(scan().map((c) => c.title)).toEqual(["Work from another login"]);
	});

	it("does not report the home store twice through a symlinked account", () => {
		seedConversation("only-once", { title: "One row" });
		const accounts = join(home, ".dev3.0", "agent-accounts", "claude");
		mkdirSync(accounts, { recursive: true });
		symlinkSync(join(home, ".claude"), join(accounts, "mine"));
		expect(scan()).toHaveLength(1);
	});

	it("never offers a session that was already imported", () => {
		seedConversation("s1");
		seedConversation("s2");
		expect(scan({ importedSessionIds: ["s1"] }).map((c) => c.sessionId)).toEqual(["s2"]);
	});

	it("returns the newest conversation first", () => {
		seedConversation("older", { ageDays: 20 });
		seedConversation("newer", { ageDays: 2 });
		expect(scan().map((c) => c.sessionId)).toEqual(["newer", "older"]);
	});
});
