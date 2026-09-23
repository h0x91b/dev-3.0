import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findLatestCodexConversation, resolveCodexResumeHome } from "../codex-resume-home";

const ID = "01a09480-c8fc-7021-b4d1-73d850b67083";
const OTHER = "019f50b3-6415-7dc3-8ad5-b60f0818f704";
let home: string;
const account = (id: string) => join(home, ".dev3.0", "agent-accounts", "codex", id);

function rollout(root: string, id = ID, archived = false, headerId = id): string {
	const path = join(root, archived ? "archived_sessions" : "sessions", "2026", "09", "14", `rollout-2026-09-14T12-00-00-${id}.jsonl`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: { id: headerId } })}\nThis body must never be parsed.\n`);
	return path;
}

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "codex-resume-home-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe("resolveCodexResumeHome", () => {
	it("finds account B by exact session id even when account A is preferred", async () => {
		writeFileSync(rollout(account("a"), OTHER), "An unrelated transcript need not be readable as JSON.\n");
		rollout(account("b"));
		expect(await resolveCodexResumeHome(ID, [account("a")], home)).toBe(realpathSync(account("b")));
	});

	it("rejects a missing exact conversation instead of selecting a newer one", async () => {
		rollout(account("a"), OTHER);
		await expect(resolveCodexResumeHome(ID, [], home)).rejects.toThrow(/not found/i);
	});

	it("rejects duplicates across different account stores", async () => {
		rollout(account("a"));
		rollout(account("b"));
		await expect(resolveCodexResumeHome(ID, [account("a")], home)).rejects.toThrow(/multiple|ambiguous/i);
	});

	it("rejects distinct active rollout files for one ID in the same home", async () => {
		const first = rollout(account("a"));
		const second = join(account("a"), "sessions", `rollout-second-${ID}.jsonl`);
		writeFileSync(second, readFileSync(first));
		await expect(resolveCodexResumeHome(ID, [], home)).rejects.toThrow(/multiple|ambiguous/i);
	});

	it("validates the header rather than trusting a matching filename", async () => {
		rollout(account("a"), ID, false, OTHER);
		await expect(resolveCodexResumeHome(ID, [], home)).rejects.toThrow(/header|metadata/i);
	});

	it("finds a session under the system home", async () => {
		rollout(join(home, ".codex"));
		expect(await resolveCodexResumeHome(ID, [], home)).toBe(realpathSync(join(home, ".codex")));
	});

	it("checks a custom configured home", async () => {
		const custom = join(home, "custom");
		rollout(custom);
		expect(await resolveCodexResumeHome(ID, [custom], home)).toBe(realpathSync(custom));
	});

	it("deduplicates home aliases and skips directory symlink loops", async () => {
		rollout(account("a"));
		symlinkSync(account("a"), account("alias"), "dir");
		symlinkSync(join(account("a"), "sessions"), join(account("a"), "sessions", "loop"), "dir");
		expect(await resolveCodexResumeHome(ID, [account("alias")], home)).toBe(realpathSync(account("a")));
	});

	it("deduplicates file aliases", async () => {
		const file = rollout(account("a"));
		const alias = join(account("a"), "sessions", `rollout-alias-${ID}.jsonl`);
		symlinkSync(file, alias);
		expect(await resolveCodexResumeHome(ID, [], home)).toBe(realpathSync(account("a")));
	});

	it("rejects distinct account homes sharing one session store", async () => {
		rollout(account("a"));
		mkdirSync(account("b"), { recursive: true });
		symlinkSync(join(account("a"), "sessions"), join(account("b"), "sessions"), "dir");
		await expect(resolveCodexResumeHome(ID, [], home)).rejects.toThrow(/multiple|ambiguous/i);
	});

	it("reports an archived conversation explicitly", async () => {
		rollout(account("a"), ID, true);
		await expect(resolveCodexResumeHome(ID, [], home)).rejects.toThrow(/archived/i);
	});

	it("rejects corrupt matching metadata", async () => {
		const file = rollout(account("a"));
		writeFileSync(file, "{broken\n");
		await expect(resolveCodexResumeHome(ID, [], home)).rejects.toThrow(/header|metadata/i);
	});

	it("rejects an interrupted first header", async () => {
		const file = rollout(account("a"));
		writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: ID } }));
		await expect(resolveCodexResumeHome(ID, [], home)).rejects.toThrow(/header|metadata/i);
	});

	it("rejects a metadata header larger than the bounded read", async () => {
		const file = rollout(account("a"));
		writeFileSync(file, `${JSON.stringify({ type: "session_meta", payload: { id: ID, padding: "x".repeat(256 * 1024) } })}\n`);
		await expect(resolveCodexResumeHome(ID, [], home)).rejects.toThrow(/metadata/i);
	});

	it("does not change session files or account auth", async () => {
		const file = rollout(account("a"));
		const auth = join(account("a"), "auth.json");
		writeFileSync(auth, "fixture-only-opaque-auth");
		const before = [file, auth].map((path) => ({ text: readFileSync(path, "utf8"), mtime: statSync(path).mtimeMs }));
		await resolveCodexResumeHome(ID, [], home);
		expect([file, auth].map((path) => ({ text: readFileSync(path, "utf8"), mtime: statSync(path).mtimeMs }))).toEqual(before);
	});

	it("reports a broken account-home symlink rather than treating it as an absent store", async () => {
		mkdirSync(dirname(account("broken")), { recursive: true });
		symlinkSync(join(home, "missing-home"), account("broken"), "dir");
		await expect(resolveCodexResumeHome(ID, [], home)).rejects.toThrow(/read.*store/i);
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reports an unreadable candidate", async () => {
		const file = rollout(account("a"));
		chmodSync(file, 0);
		try { await expect(resolveCodexResumeHome(ID, [], home)).rejects.toThrow(/read|permission/i); }
		finally { chmodSync(file, 0o600); }
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("fails on an unreadable store instead of choosing another account", async () => {
		rollout(account("a"));
		rollout(account("b"), OTHER);
		const dir = join(account("b"), "sessions");
		chmodSync(dir, 0);
		try { await expect(resolveCodexResumeHome(ID, [], home)).rejects.toThrow(/scan|read|permission/i); }
		finally { chmodSync(dir, 0o700); }
	});

	it("rejects malformed ids before touching stores", async () => {
		await expect(resolveCodexResumeHome("../session", [], home)).rejects.toThrow(/invalid|UUID/i);
	});
});

describe("findLatestCodexConversation", () => {
	const WT = "/Users/me/.dev3.0/worktrees/proj/5a354452/worktree";
	const THIRD = "01a0cd81-4aeb-7cf3-ab4a-d793d9e74ead";
	let clock = 1_790_000_000;

	function conversation(root: string, id: string, payload: Record<string, unknown>): string {
		const path = join(root, "sessions", "2026", "09", "12", `rollout-2026-09-12T10-24-23-${id}.jsonl`);
		mkdirSync(dirname(path), { recursive: true });
		// Real headers carry a large instructions blob after the fields we need.
		const header = { timestamp: "2026-09-12T07:24:44.487Z", type: "session_meta", payload: { session_id: id, id, timestamp: "2026-09-12T07:24:23.196Z", cwd: WT, source: "cli", thread_source: "user", originator: "codex-tui", ...payload, base_instructions: "x".repeat(20_000) } };
		writeFileSync(path, `${JSON.stringify(header)}\nconversation body\n`);
		clock += 60;
		utimesSync(path, clock, clock);
		return path;
	}

	it("finds the worktree's conversation in a non-default account's store", async () => {
		conversation(account("default"), OTHER, { cwd: "/somewhere/else" });
		conversation(account("original"), ID, {});
		expect(await findLatestCodexConversation(WT, [], home)).toBe(ID);
	});

	it("prefers the most recently used conversation over an older one of the same worktree", async () => {
		// Store "a" is scanned first, so only the recency order can pick "b".
		conversation(account("a"), ID, {});
		const resumedLater = conversation(account("b"), THIRD, {});
		clock += 600;
		utimesSync(resumedLater, clock, clock);
		expect(await findLatestCodexConversation(WT, [], home)).toBe(THIRD);
	});

	it.each([
		["a subagent thread", { source: { subagent: { thread_spawn: { parent_thread_id: ID } } }, thread_source: "subagent" }],
		["a codex exec run", { source: "exec", originator: "codex_exec" }],
		["an IDE thread", { source: "vscode" }],
		["another worktree whose path starts the same", { cwd: `${WT}-2` }],
	])("ignores %s even when it is newer", async (_label, payload) => {
		conversation(account("a"), ID, {});
		conversation(account("b"), OTHER, payload);
		expect(await findLatestCodexConversation(WT, [], home)).toBe(ID);
	});

	it("skips archived conversations and returns null when nothing matches", async () => {
		const path = join(account("a"), "archived_sessions", `rollout-x-${ID}.jsonl`);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: { id: ID, cwd: WT, source: "cli" } })}\n`);
		expect(await findLatestCodexConversation(WT, [], home)).toBeNull();
	});

	it("tolerates a corrupt header next to a valid conversation", async () => {
		conversation(account("a"), ID, {});
		const broken = join(account("b"), "sessions", `rollout-y-${OTHER}.jsonl`);
		mkdirSync(dirname(broken), { recursive: true });
		writeFileSync(broken, `{"type":"session_meta","payload":{"cwd":${JSON.stringify(WT)}`);
		expect(await findLatestCodexConversation(WT, [], home)).toBe(ID);
	});

	it("hands resolveCodexResumeHome an id it resolves to the holding store", async () => {
		conversation(account("original"), ID, {});
		const found = await findLatestCodexConversation(WT, [account("default")], home);
		expect(await resolveCodexResumeHome(found!, [account("default")], home)).toBe(realpathSync(account("original")));
	});
});
