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
	titleFromFirstRequest,
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
	/** What Claude recorded as the client — `claude-desktop` for the desktop app. */
	entrypoint?: string;
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
			...(options.entrypoint ? { entrypoint: options.entrypoint } : {}),
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
	it("names a main conversation, its branch and its turns, titled by Claude or not", () => {
		const file = seedConversation("s1", { title: "Fix the parser", gitBranch: "feat/x", prompts: ["one", "two"] });
		const classified = classifyClaudeTranscript(readFileSync(file, "utf-8"));
		expect(classified).toMatchObject({ kind: "main", title: "Fix the parser", gitBranch: "feat/x", turns: 2 });

		// `ai-title` is optional and often missing (221 of 829 files on the machine this
		// was measured on). A session the human spoke in is a main session either way.
		const untitled = seedConversation("s4", { title: null, prompts: ["Fix the parser", "now the renderer"] });
		expect(classifyClaudeTranscript(readFileSync(untitled, "utf-8"))).toMatchObject({
			kind: "main",
			title: null,
			firstRequest: "Fix the parser",
			turns: 2,
		});
	});

	it("tells subagent, teammate and empty transcripts apart from a main one", () => {
		const kindOf = (file: string) => classifyClaudeTranscript(readFileSync(file, "utf-8")).kind;
		expect(kindOf(seedConversation("s2", { sidechain: true })), "sidechain").toBe("subagent");
		expect(kindOf(seedConversation("s3", { teammate: true })), "agent-setting").toBe("teammate");
		expect(kindOf(seedConversation("s5", { title: null, prompts: [] })), "nobody spoke").toBe("empty");
	});

	// The harness echoes a slash command back into the `user` role. It is neither a
	// turn nor a title; agent-to-agent traffic, also tag-wrapped, still is a turn.
	it("ignores the wrappers Claude writes into the user role, but keeps agent-to-agent traffic", () => {
		const file = seedConversation("s6", {
			title: null,
			prompts: ["<command-name>/clear</command-name>", "<bash-input>ls</bash-input>", "Fix the parser"],
		});
		expect(classifyClaudeTranscript(readFileSync(file, "utf-8"))).toMatchObject({
			kind: "main",
			firstRequest: "Fix the parser",
			turns: 1,
		});
		const agent = seedConversation("s7", { title: null, prompts: ["<dev3-ai-message>\n<from-task>seq:7</from-task>\n</dev3-ai-message>"] });
		expect(classifyClaudeTranscript(readFileSync(agent, "utf-8")).turns).toBe(1);
	});
});

describe("scanImportableConversations", () => {
	it("offers a titled conversation that ran in the project, filed by age", () => {
		seedConversation("s1", { title: "Fix the parser", gitBranch: "feat/x", ageDays: 1 });
		expect(scan()).toMatchObject([{
			sessionId: "s1",
			title: "Fix the parser",
			workingDir: project,
			gitBranch: "feat/x",
			turns: 1,
			targetStatus: "user-questions",
		}]);

		// Work from the last week files into Has Questions, older work into Completed.
		seedConversation("recent", { ageDays: 3 });
		seedConversation("old", { ageDays: 40 });
		const byId = new Map(scan().map((c) => [c.sessionId, c.targetStatus]));
		expect(byId.get("recent")).toBe("user-questions");
		expect(byId.get("old")).toBe("completed");
	});

	it("offers nothing for subagent, teammate, empty, wrapper-only or id-less transcripts", () => {
		seedConversation("sub", { sidechain: true });
		seedConversation("team", { teammate: true });
		seedConversation("silent", { title: null, prompts: [] });
		seedConversation("commands", { title: null, prompts: ["<command-name>/clear</command-name>"] });
		const dir = join(home, ".claude", "projects", claudeEncodePath(project));
		writeFileSync(
			join(dir, "no-id.jsonl"),
			`${JSON.stringify({ type: "user", cwd: project, message: { role: "user", content: [{ type: "text", text: "Fix it" }] } })}\n`,
		);
		expect(scan()).toEqual([]);
	});

	// The bug this replaced: a missing `ai-title` hid a real conversation entirely.
	it("offers a conversation Claude never titled, named after the first request", () => {
		seedConversation("bare", { title: null, prompts: ["Fix the parser"], ageDays: 1 });
		expect(scan()).toMatchObject([{
			source: "claude",
			sessionId: "bare",
			title: "Fix the parser",
			titledFromRequest: true,
			workingDir: project,
			turns: 1,
		}]);
	});

	it("offers titled and untitled sessions together, newest first, and never one twice", () => {
		seedConversation("named", { title: "Fix the parser", ageDays: 1 });
		seedConversation("bare", { title: null, prompts: ["Rework the importer"], ageDays: 2 });
		seedConversation("older", { title: null, prompts: ["Something older"], ageDays: 20 });
		const all = scan();
		expect(all.map((c) => c.sessionId)).toEqual(["named", "bare", "older"]);
		expect(all[0]).toMatchObject({ title: "Fix the parser", titledFromRequest: false });
		expect(scan({ importedSessionIds: ["bare"] }).map((c) => c.sessionId)).toEqual(["named", "older"]);
	});

	// A transcript still being written ends mid-line, and a crashed one can hold
	// half a record. Neither may cost the conversation its place on the list.
	it("still offers a conversation whose file holds a broken line", () => {
		const file = seedConversation("torn", { title: null, prompts: ["Fix the parser"] });
		writeFileSync(file, `${readFileSync(file, "utf-8")}{"type":"user","message":{"role"`);
		expect(scan().map((c) => [c.sessionId, c.title])).toEqual([["torn", "Fix the parser"]]);
	});

	it("never offers a conversation that ran inside a dev3 worktree, default or redirected home", () => {
		const worktree = join(home, ".dev3.0", "worktrees", "code-dev-3-0", "abcd1234", "worktree");
		mkdirSync(worktree, { recursive: true });
		seedConversation("inside-dev3", { workingDir: worktree, cwd: worktree });
		// Even asked about the dev3 path directly, which no project may ever be.
		expect(scanImportableConversations({ projectPath: worktree, home, nowMs: NOW })).toEqual([]);
		expect(scan()).toEqual([]);

		// A `--qa` board keeps its worktrees under its own DEV3_HOME, which is not
		// `~/.dev3.0` at all — its own work must stay just as invisible.
		const scoped = join(home, "qa-root");
		const qaWorktree = join(scoped, "worktrees", "code-dev-3-0", "abcd1234", "worktree");
		mkdirSync(qaWorktree, { recursive: true });
		seedConversation("inside-qa", { workingDir: qaWorktree, cwd: qaWorktree });
		expect(scan({ dev3Home: scoped })).toEqual([]);
	});

	it("offers a live subdirectory session, but not a sibling whose name merely starts the same, nor a gone or unrecorded cwd", () => {
		const sibling = join(home, "code", "dev-3.0-scratch");
		mkdirSync(sibling, { recursive: true });
		seedConversation("sibling", { workingDir: sibling, cwd: sibling });
		const deep = join(project, "packages", "cli");
		mkdirSync(deep, { recursive: true });
		seedConversation("deep", { workingDir: deep, cwd: deep });
		const gone = join(project, "deleted-worktree");
		seedConversation("vanished", { workingDir: gone, cwd: gone });
		const sub = join(project, "packages", "web");
		mkdirSync(sub, { recursive: true });
		seedConversation("nocwd", { workingDir: sub, cwd: null });
		expect(scan()).toMatchObject([{ sessionId: "deep", workingDir: deep }]);
	});

	it("finds a conversation under a dev3 agent account, but the home store only once through a symlink", () => {
		const accounts = join(home, ".dev3.0", "agent-accounts", "claude");
		seedConversation("second-account", { configDir: join(accounts, "acc-1"), title: "Work from another login", ageDays: 1 });
		seedConversation("only-once", { title: "One row", ageDays: 2 });
		symlinkSync(join(home, ".claude"), join(accounts, "mine"));
		expect(scan().map((c) => c.title)).toEqual(["Work from another login", "One row"]);
	});

	it("finds the conversation when the project path carries a trailing slash or a symlink", () => {
		// A store name is the encoding of a cwd, which never has a trailing slash; and
		// Claude records the PHYSICAL working directory, while the folder picker
		// stored whichever link the user browsed through.
		seedConversation("s1", { title: "Fix the parser", workingDir: realpathSync(project) });
		expect(scan({ projectPath: `${project}/` }).map((c) => c.sessionId)).toEqual(["s1"]);
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

	// The rule that a blanket "starts with a tag" test got wrong: agent-to-agent
	// traffic is a message a person's board really sent, and dropping it loses a turn.
	it("keeps agent-to-agent traffic and ordinary prose, including prose that opens with a heading", () => {
		expect(isCodexInjectedUserText("<dev3-ai-message>\n<from-task>seq:1141</from-task>\n</dev3-ai-message>")).toBe(false);
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
	it("reports nothing for a head with no complete line or no session_meta", () => {
		expect(codexHeaderFrom('{"type":"session_meta","payload":{"id":"s1"')).toBeNull();
		expect(codexHeaderFrom('{"type":"response_item","payload":{}}\n')).toBeNull();
	});
});

describe("titleFromFirstRequest", () => {
	it("takes the first non-empty line of the request, and has none without a request", () => {
		expect(titleFromFirstRequest("\n\nFix the parser\nand then the renderer")).toBe("Fix the parser");
		expect(titleFromFirstRequest(null)).toBeNull();
	});

	it("cuts an over-long request at the width a task title has", () => {
		const title = titleFromFirstRequest("x".repeat(200));
		expect(title).toHaveLength(80);
		expect(title?.endsWith("…")).toBe(true);
	});
});

describe("classifyCodexRollout", () => {
	it("counts only what the human asked for, not injected context, and names the session after the first", () => {
		const file = seedRollout("s1", {
			gitBranch: "feat/x",
			injected: ["# AGENTS.md instructions for /x", "<environment_context>\n</environment_context>"],
			prompts: ["Fix the parser", "now the renderer"],
		});
		expect(classifyCodexRollout(readFileSync(file, "utf-8"))).toEqual({
			sessionId: "s1",
			cwd: project,
			gitBranch: "feat/x",
			firstRequest: "Fix the parser",
			turns: 2,
		});
	});
});

describe("scanImportableConversations, Codex rollouts", () => {
	it("offers a rollout that ran in the project, titled after the first request, until imported", () => {
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
		expect(scan({ importedSessionIds: ["c1"] })).toEqual([]);
	});

	it("offers Claude and Codex side by side, newest first, including agent-account rollouts", () => {
		seedConversation("s1", { ageDays: 9 });
		seedRollout("c1", { ageDays: 2 });
		expect(scan().map((c) => [c.source, c.sessionId])).toEqual([["codex", "c1"], ["claude", "s1"]]);

		// A rollout under a dev3 agent account is found too.
		seedRollout("c2", { codexHome: join(home, ".dev3.0", "agent-accounts", "codex", "acct-1"), ageDays: 20 });
		expect(scan().map((c) => c.sessionId)).toEqual(["c1", "s1", "c2"]);
	});

	it("offers a subdirectory rollout, never one from a dev3 worktree or a same-prefix sibling", () => {
		const worktree = join(home, ".dev3.0", "worktrees", "slug", "abc", "worktree");
		mkdirSync(worktree, { recursive: true });
		seedRollout("c3", { workingDir: worktree });
		const sibling = `${project}-scratch`;
		mkdirSync(sibling, { recursive: true });
		seedRollout("c4", { workingDir: sibling });
		// A subdirectory of the project, by contrast, is offered.
		const inner = join(project, "packages", "cli");
		mkdirSync(inner, { recursive: true });
		seedRollout("c5", { workingDir: inner });
		expect(scan()).toMatchObject([{ sessionId: "c5", workingDir: inner }]);
	});

	// A session that only ever received injected context has nothing to name a card
	// after, and nothing in it for anyone to pick up.
	it("skips a rollout with no cwd, no header, or no human turn", () => {
		seedRollout("c6", { cwd: null });
		seedRollout("c7", { headerless: true });
		seedRollout("c8", { prompts: [] });
		expect(scan()).toEqual([]);
	});
});
