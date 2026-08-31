/**
 * Discovery for the conversation import: which Claude Code and Codex
 * conversations a project is offered, and which it must never be offered.
 *
 * Every case builds a temporary home with hand-written JSONL — nothing here may
 * depend on the developer's own `~/.claude`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeEncodePath } from "../../shared/conversation-search-core";
import {
	classifyClaudeTranscript,
	classifyCodexRollout,
	codexHeaderFrom,
	codexTitleFrom,
	scanImportableConversations,
} from "../conversation-import";
import { isCodexInjectedUserText } from "../../shared/conversation-parsers/codex";

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

interface CodexSeedOptions {
	/** Codex home the rollout lives under. Defaults to `~/.codex`. */
	codexHome?: string;
	workingDir?: string;
	/** Omitted entirely when null — a rollout whose header records no cwd. */
	cwd?: string | null;
	gitBranch?: string | null;
	prompts?: string[];
	/** Blocks Codex writes into the `user` role itself. Never a turn, never a title. */
	injected?: string[];
	/** Drop the `session_meta` line, so the file is not a rollout at all. */
	headerless?: boolean;
	ageDays?: number;
}

function seedRollout(sessionId: string, options: CodexSeedOptions = {}): string {
	const codexHome = options.codexHome ?? join(home, ".codex");
	const workingDir = options.workingDir ?? project;
	const dir = join(codexHome, "sessions", "2026", "08", "20");
	mkdirSync(dir, { recursive: true });

	const userMessage = (text: string) => ({
		timestamp: "2026-08-20T10:00:00.000Z",
		type: "response_item",
		payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
	});

	const records: Record<string, unknown>[] = [
		...(options.headerless ? [] : [{
			timestamp: "2026-08-20T09:59:00.000Z",
			type: "session_meta",
			payload: {
				id: sessionId,
				...(options.cwd === null ? {} : { cwd: options.cwd ?? workingDir }),
				originator: "codex-tui",
				...(options.gitBranch ? { git: { branch: options.gitBranch } } : {}),
			},
		}]),
		// Codex opens sessions with its own context in the `user` role.
		...(options.injected ?? ["# AGENTS.md instructions for /somewhere"]).map(userMessage),
		...(options.prompts ?? ["Make the thing work"]).map(userMessage),
		{
			timestamp: "2026-08-20T10:00:01.000Z",
			type: "response_item",
			payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
		},
	];

	const file = join(dir, `rollout-2026-08-20T10-00-00-${sessionId}.jsonl`);
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

	it("finds the conversation when the stored project path carries a trailing slash", () => {
		// A store name is the encoding of a cwd, which never has one, and the
		// encoding maps `/` to `-` — so `…app/` encodes to a directory that exists
		// nowhere and the scan quietly returns nothing.
		seedConversation("s1", { title: "Fix the parser" });
		expect(scan({ projectPath: `${project}/` }).map((c) => c.sessionId)).toEqual(["s1"]);
	});

	it("finds the conversation when the project is registered through a symlink", () => {
		// Claude records the PHYSICAL working directory, while the folder picker
		// stored whichever link the user browsed through.
		seedConversation("s1", { title: "Fix the parser", workingDir: realpathSync(project) });
		const link = join(home, "linked-project");
		symlinkSync(project, link);
		expect(scan({ projectPath: link }).map((c) => c.sessionId)).toEqual(["s1"]);
	});
});

describe("isCodexInjectedUserText", () => {
	it("recognises the context blocks Codex writes into the user role", () => {
		for (const text of [
			"# AGENTS.md instructions for /code/dev-3.0",
			"<environment_context>\n  <cwd>/code</cwd>\n</environment_context>",
			"<turn_aborted>\nThe user interrupted the previous turn.\n</turn_aborted>",
			"<skill>\n<name>dev3</name>\n</skill>",
			"# Files mentioned by the user:\n\n## shot.png: /tmp/shot.png",
			"Warning: apply_patch was requested via shell. Use the apply_patch tool.",
			// A space inside the tag: matching the first word alone silently misses it.
			"<permissions instructions>\nNever run destructive commands.\n</permissions instructions>",
			// Attributes after the name: matching the whole body alone silently misses it.
			'<image src="/tmp/shot.png">',
		]) {
			expect(isCodexInjectedUserText(text)).toBe(true);
		}
	});

	// The rule that a blanket "starts with a tag" test got wrong: this is a message
	// a person's board really sent, and dropping it loses a real turn.
	it("keeps agent-to-agent traffic, which arrives in the user role wrapped in a tag", () => {
		expect(isCodexInjectedUserText("<dev3-ai-message>\n<from-task>seq:1141</from-task>\n</dev3-ai-message>")).toBe(false);
	});

	it("keeps ordinary prose, including prose that opens with a heading", () => {
		expect(isCodexInjectedUserText("please fix the parser")).toBe(false);
		expect(isCodexInjectedUserText("# My own notes\n\nfix the parser")).toBe(false);
	});
});

describe("codexHeaderFrom", () => {
	it("reads the session id and cwd out of the first line", () => {
		const head = `${JSON.stringify({ type: "session_meta", payload: { id: "s1", cwd: "/code" } })}\n{"type":"response_item"}`;
		expect(codexHeaderFrom(head)).toEqual({ sessionId: "s1", cwd: "/code" });
	});

	// A header that did not fit the read budget arrives without its newline. Half a
	// JSON object must never be guessed at.
	it("reports nothing when the head holds no complete line", () => {
		expect(codexHeaderFrom('{"type":"session_meta","payload":{"id":"s1"')).toBeNull();
	});

	it("reports nothing for a file that does not open with a session_meta", () => {
		expect(codexHeaderFrom('{"type":"response_item","payload":{}}\n')).toBeNull();
	});
});

describe("codexTitleFrom", () => {
	it("takes the first non-empty line of the request", () => {
		expect(codexTitleFrom("\n\nFix the parser\nand then the renderer")).toBe("Fix the parser");
	});

	it("cuts an over-long request at the width a task title has", () => {
		const title = codexTitleFrom("x".repeat(200));
		expect(title).toHaveLength(80);
		expect(title?.endsWith("…")).toBe(true);
	});

	it("has no title for a session the human never spoke in", () => {
		expect(codexTitleFrom(null)).toBeNull();
	});
});

describe("classifyCodexRollout", () => {
	it("counts only what the human asked for, and names the session after the first of them", () => {
		const file = seedRollout("s1", { gitBranch: "feat/x", prompts: ["Fix the parser", "now the renderer"] });
		expect(classifyCodexRollout(readFileSync(file, "utf-8"))).toEqual({
			sessionId: "s1",
			cwd: project,
			gitBranch: "feat/x",
			firstRequest: "Fix the parser",
			turns: 2,
		});
	});

	it("does not count Codex's own injected context as a turn", () => {
		const file = seedRollout("s2", {
			injected: ["# AGENTS.md instructions for /x", "<environment_context>\n</environment_context>"],
			prompts: ["Fix the parser"],
		});
		expect(classifyCodexRollout(readFileSync(file, "utf-8")).turns).toBe(1);
	});
});

describe("scanImportableConversations, Codex rollouts", () => {
	it("offers a rollout that ran in the project, titled after the first request", () => {
		seedRollout("c1", { prompts: ["Fix the parser"], gitBranch: "feat/x", ageDays: 1 });
		expect(scan()).toMatchObject([{
			source: "codex",
			sessionId: "c1",
			title: "Fix the parser",
			workingDir: project,
			gitBranch: "feat/x",
			turns: 1,
			targetStatus: "user-questions",
		}]);
	});

	it("offers Claude and Codex side by side, newest first", () => {
		seedConversation("s1", { ageDays: 9 });
		seedRollout("c1", { ageDays: 2 });
		expect(scan().map((c) => [c.source, c.sessionId])).toEqual([["codex", "c1"], ["claude", "s1"]]);
	});

	it("finds a rollout that ran under a dev3 agent account", () => {
		seedRollout("c2", { codexHome: join(home, ".dev3.0", "agent-accounts", "codex", "acct-1") });
		expect(scan().map((c) => c.sessionId)).toEqual(["c2"]);
	});

	it("never offers a rollout that ran inside a dev3 worktree", () => {
		const worktree = join(home, ".dev3.0", "worktrees", "slug", "abc", "worktree");
		mkdirSync(worktree, { recursive: true });
		seedRollout("c3", { workingDir: worktree });
		expect(scan()).toEqual([]);
	});

	it("does not let a project claim a sibling whose name merely starts the same", () => {
		const sibling = `${project}-scratch`;
		mkdirSync(sibling, { recursive: true });
		seedRollout("c4", { workingDir: sibling });
		expect(scan()).toEqual([]);
	});

	it("offers a rollout that ran in a subdirectory of the project", () => {
		const inner = join(project, "packages", "cli");
		mkdirSync(inner, { recursive: true });
		seedRollout("c5", { workingDir: inner });
		expect(scan()).toMatchObject([{ sessionId: "c5", workingDir: inner }]);
	});

	it("skips a rollout whose header recorded no working directory", () => {
		seedRollout("c6", { cwd: null });
		expect(scan()).toEqual([]);
	});

	it("skips a file that is not a rollout at all", () => {
		seedRollout("c7", { headerless: true });
		expect(scan()).toEqual([]);
	});

	// A session that only ever received injected context has nothing to name a card
	// after, and nothing in it for anyone to pick up.
	it("skips a rollout the human never spoke in", () => {
		seedRollout("c8", { prompts: [] });
		expect(scan()).toEqual([]);
	});

	it("never offers a rollout that was already imported", () => {
		seedRollout("c9");
		expect(scan({ importedSessionIds: ["c9"] })).toEqual([]);
	});
});
