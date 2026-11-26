import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { guardFsPromises, type FsRootGuard } from "./helpers/fs-root-guard";

// Real store discovery runs here: any path outside the fixture fails the test.
const fsGuard = vi.hoisted((): FsRootGuard => ({ roots: null, violations: [] }));
vi.mock("node:fs/promises", async (actual) => guardFsPromises(await actual<Record<string, unknown>>(), fsGuard));
import { codexScanBound, isInteractiveCodexConversation, resolveCodexResumeHome, selectCodexConversations, type CodexPaneSnapshot, type CodexSelectionInput } from "../codex-resume-home";

const ID = "00000000-0000-4000-8000-0000c0de1083";
const OTHER = "00000000-0000-4000-8000-0000c0de2704";
let home: string;
const account = (id: string) => join(home, ".dev3.0", "agent-accounts", "codex", id);

function rollout(root: string, id = ID, archived = false, headerId = id): string {
	const path = join(root, archived ? "archived_sessions" : "sessions", "2026", "09", "14", `rollout-2026-09-14T12-00-00-${id}.jsonl`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: { id: headerId } })}\nThis body must never be parsed.\n`);
	return path;
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "codex-resume-home-"));
	fsGuard.violations = [];
	fsGuard.roots = [home, realpathSync(home)];
});
afterEach(() => {
	fsGuard.roots = null;
	rmSync(home, { recursive: true, force: true });
	expect(fsGuard.violations).toEqual([]);
});

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

	it("finds a session under the system home and under a custom configured home", async () => {
		rollout(join(home, ".codex"));
		expect(await resolveCodexResumeHome(ID, [], home)).toBe(realpathSync(join(home, ".codex")));
		rmSync(join(home, ".codex"), { recursive: true });
		const custom = join(home, "custom");
		rollout(custom);
		expect(await resolveCodexResumeHome(ID, [custom], home)).toBe(realpathSync(custom));
	});

	it("deduplicates home and file aliases and skips directory symlink loops", async () => {
		const file = rollout(account("a"));
		symlinkSync(account("a"), account("alias"), "dir");
		symlinkSync(join(account("a"), "sessions"), join(account("a"), "sessions", "loop"), "dir");
		symlinkSync(file, join(account("a"), "sessions", `rollout-alias-${ID}.jsonl`));
		expect(await resolveCodexResumeHome(ID, [account("alias")], home)).toBe(realpathSync(account("a")));
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

	it("validates the header: mismatched id, corrupt, interrupted, or larger than the bounded read", async () => {
		const file = rollout(account("a"), ID, false, OTHER);
		const cases: Array<[string, string]> = [
			["mismatched header id", readFileSync(file, "utf8")],
			["corrupt", "{broken\n"],
			["interrupted", JSON.stringify({ type: "session_meta", payload: { id: ID } })],
			["oversized", `${JSON.stringify({ type: "session_meta", payload: { id: ID, padding: "x".repeat(256 * 1024) } })}\n`],
		];
		for (const [label, text] of cases) {
			writeFileSync(file, text);
			await expect(resolveCodexResumeHome(ID, [], home), label).rejects.toThrow(/header|metadata/i);
		}
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

describe("selectCodexConversations", () => {
	const WT = "/Users/me/.dev3.0/worktrees/proj/5a354452/worktree";
	const THIRD = "00000000-0000-4000-8000-0000c0de3ead";
	const RUN_START = Date.parse("2026-09-12T07:00:00.000Z");
	let clock = RUN_START / 1000 + 3600;

	/** A rollout started `startMin` minutes after the run began, last written after every earlier one. */
	function conversation(root: string, id: string, payload: Record<string, unknown> = {}, startMin = 10): string {
		const path = join(root, "sessions", "2026", "09", "12", `rollout-2026-09-12T10-24-23-${id}.jsonl`);
		mkdirSync(dirname(path), { recursive: true });
		// Real headers carry a large instructions blob after the fields we need.
		const header = { timestamp: "2026-09-12T07:24:44.487Z", type: "session_meta", payload: { session_id: id, id, timestamp: new Date(RUN_START + startMin * 60_000).toISOString(), cwd: WT, source: "cli", thread_source: "user", originator: "codex-tui", ...payload, base_instructions: "x".repeat(20_000) } };
		writeFileSync(path, `${JSON.stringify(header)}\nconversation body\n`);
		clock += 60;
		utimesSync(path, clock, clock);
		return path;
	}
	const touch = (path: string) => { clock += 60; utimesSync(path, clock, clock); };
	const pane = (overrides: Partial<CodexPaneSnapshot> = {}): CodexPaneSnapshot => ({ sessionId: null, live: false, resumeNow: true, ...overrides });
	function select(overrides: Partial<CodexSelectionInput> = {}) {
		return selectCodexConversations({
			intent: "explicit-resume",
			scanWorktree: WT,
			panes: [pane()],
			runBoundary: { lifecycleStartedAt: new Date(RUN_START).toISOString(), worktreeBirthMs: RUN_START, floorAt: null },
			additionalHomes: [],
			home,
			...overrides,
		});
	}
	const picked = async (overrides: Partial<CodexSelectionInput> = {}) => (await select(overrides)).map((s) => (s.kind === "selected" ? s.sessionId : s.kind));

	describe("never another task's conversation (#1847)", () => {
		it("takes this worktree's conversation even when a sibling worktree has a newer one", async () => {
			conversation(join(home, ".codex"), ID);
			conversation(join(home, ".codex"), OTHER, { cwd: "/Users/me/.dev3.0/worktrees/proj/aaaaaaaa/worktree" });
			expect(await picked()).toEqual([ID]);
		});

		it("ignores subagent, exec, IDE and prefix-sibling conversations even when they are newer", async () => {
			conversation(account("a"), ID);
			const noise: Array<Record<string, unknown>> = [
				{ source: { subagent: { thread_spawn: { parent_thread_id: ID } } }, thread_source: "subagent" },
				{ source: "exec", originator: "codex_exec" },
				{ source: "vscode" },
				{ cwd: `${WT}-2` },
			];
			noise.forEach((payload, i) => conversation(account(`noise${i}`), OTHER, payload));
			expect(await picked()).toEqual([ID]);
		});

		it("refuses with none, never --last, when nothing of this worktree exists", async () => {
			conversation(join(home, ".codex"), OTHER, { cwd: "/elsewhere" });
			const [result] = await select();
			expect(result).toMatchObject({ kind: "none" });
		});

		it("does not scan archived conversations", async () => {
			const path = join(account("a"), "archived_sessions", `rollout-x-${ID}.jsonl`);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: { id: ID, cwd: WT, source: "cli", timestamp: new Date(RUN_START + 60_000).toISOString() } })}\n`);
			expect(await picked()).toEqual(["none"]);
		});

		it("scans nothing when the task has no managed worktree (Operations folder)", async () => {
			conversation(account("a"), ID);
			expect(await picked({ scanWorktree: null })).toEqual(["none"]);
		});

		it("tolerates a corrupt header next to a valid conversation", async () => {
			conversation(account("a"), ID);
			const broken = join(account("b"), "sessions", `rollout-y-${OTHER}.jsonl`);
			mkdirSync(dirname(broken), { recursive: true });
			writeFileSync(broken, `{"type":"session_meta","payload":{"cwd":${JSON.stringify(WT)}`);
			expect(await picked()).toEqual([ID]);
		});
	});

	describe("explicit-resume", () => {
		it("resumes a saved id exactly, even when a newer conversation exists", async () => {
			conversation(account("a"), ID);
			conversation(account("a"), OTHER);
			expect(await select({ panes: [pane({ sessionId: ID })] })).toEqual([{ kind: "selected", sessionId: ID, codexHome: realpathSync(account("a")), via: "stored" }]);
		});

		it("surfaces a missing saved id unchanged instead of substituting", async () => {
			conversation(account("a"), OTHER);
			await expect(select({ panes: [pane({ sessionId: ID })] })).rejects.toThrow(/not found/i);
		});

		it("without a saved id takes the newest conversation no other pane owns", async () => {
			conversation(account("a"), ID);
			conversation(account("a"), OTHER);
			const result = await select({ panes: [pane(), pane({ sessionId: OTHER, resumeNow: false })] });
			expect(result[0]).toMatchObject({ kind: "selected", sessionId: ID, via: "latest-owned" });
		});

		it("refuses when another Codex pane is live, even bound to a newer conversation of its own (F5, no contest)", async () => {
			conversation(account("a"), ID);
			expect(await picked({ panes: [pane(), pane({ live: true, resumeNow: false })] })).toEqual(["ambiguous", "not-requested"]);
			conversation(account("a"), THIRD);
			const live = { sessionId: THIRD, resumeNow: false };
			expect(await picked({ panes: [pane(), pane({ ...live, live: true })] })).toEqual(["ambiguous", "not-requested"]);
			expect(await picked({ panes: [pane(), pane({ ...live, live: false })] })).toEqual([ID, "not-requested"]);
		});
	});

	describe("automatic-recovery", () => {
		it("takes a newer unbound conversation over the saved id (newest wins)", async () => {
			conversation(account("a"), ID);
			conversation(account("a"), OTHER);
			expect(await select({ intent: "automatic-recovery", panes: [pane({ sessionId: ID })] })).toEqual([expect.objectContaining({ kind: "selected", sessionId: OTHER, via: "latest-owned" })]);
		});

		it("keeps the saved id when it is the newest", async () => {
			conversation(account("a"), OTHER);
			const own = conversation(account("a"), ID);
			touch(own);
			expect(await picked({ intent: "automatic-recovery", panes: [pane({ sessionId: ID })] })).toEqual([ID]);
		});

		it("refuses the newer unbound conversation when another pane is live, even if that pane's own id is newest (F5)", async () => {
			conversation(account("a"), ID);
			conversation(account("a"), OTHER);
			conversation(account("a"), THIRD);
			const panes = (live: boolean) => [pane({ sessionId: ID }), pane({ sessionId: THIRD, live, resumeNow: false })];
			expect(await picked({ intent: "automatic-recovery", panes: panes(true) })).toEqual(["ambiguous", "not-requested"]);
			expect(await picked({ intent: "automatic-recovery", panes: panes(false) })).toEqual([OTHER, "not-requested"]);
		});

		it("refuses rather than falling back to the older saved id when another pane is live", async () => {
			conversation(account("a"), ID);
			conversation(account("a"), OTHER);
			expect(await picked({ intent: "automatic-recovery", panes: [pane({ sessionId: ID }), pane({ sessionId: THIRD, live: true, resumeNow: false })] }))
				.toEqual(["ambiguous", "not-requested"]);
		});

		it("refuses both panes when one unbound conversation is newest for both (example D)", async () => {
			conversation(account("a"), ID);
			conversation(account("a"), THIRD);
			conversation(account("a"), OTHER);
			const result = await select({ intent: "automatic-recovery", panes: [pane({ sessionId: ID }), pane({ sessionId: THIRD })] });
			expect(result.map((r) => r.kind)).toEqual(["ambiguous", "ambiguous"]);
			expect(result[0]).toMatchObject({ reason: expect.stringContaining(OTHER) });
		});

		it("lets an unaffected pane through: its saved id is newer than the contested one", async () => {
			conversation(account("a"), ID);
			conversation(account("a"), OTHER);
			const own = conversation(account("a"), THIRD);
			touch(own);
			expect(await picked({ intent: "automatic-recovery", panes: [pane({ sessionId: ID }), pane({ sessionId: THIRD })] })).toEqual([OTHER, THIRD]);
		});

		it("counts panes it is not resuming now when deciding a conversation is contested", async () => {
			conversation(account("a"), ID);
			conversation(account("a"), OTHER);
			expect(await picked({ intent: "automatic-recovery", panes: [pane(), pane({ resumeNow: false })] })).toEqual(["ambiguous", "not-requested"]);
		});
	});

	describe("reopen", () => {
		it("resumes a saved id exactly, and refuses without one even when a conversation of the worktree exists", async () => {
			conversation(account("a"), ID);
			conversation(account("a"), OTHER);
			expect(await picked({ intent: "reopen", panes: [pane({ sessionId: ID })] })).toEqual([ID]);
			const [result] = await select({ intent: "reopen" });
			expect(result).toMatchObject({ kind: "none", reason: expect.stringContaining("codex resume <id>") });
		});
	});

	describe("accounts", () => {
		it("a managed account scans only its own store; an unrecorded one with conversations in two stores is ambiguous", async () => {
			conversation(account("a"), ID);
			conversation(account("b"), OTHER);
			expect(await picked({ panes: [pane({ accountId: "a" })] })).toEqual([ID]);
			expect(await picked()).toEqual(["ambiguous"]);
		});

		it("null means the non-managed homes, configured ones included, never a managed account; two of them is ambiguous", async () => {
			const custom = join(home, "custom");
			conversation(account("a"), OTHER);
			conversation(custom, ID);
			expect(await picked({ panes: [pane({ accountId: null })], additionalHomes: [custom] })).toEqual([ID]);
			conversation(join(home, ".codex"), THIRD);
			expect(await picked({ panes: [pane({ accountId: null })], additionalHomes: [custom] })).toEqual(["ambiguous"]);
		});

		it("a saved id stored under another account refuses, on the exact path too", async () => {
			conversation(account("b"), ID);
			expect(await picked({ panes: [pane({ sessionId: ID, accountId: "a" })] })).toEqual(["account-mismatch"]);
			expect(await picked({ panes: [pane({ sessionId: ID, accountId: null })] })).toEqual(["account-mismatch"]);
		});

		it("a saved id without a recorded account follows its store (legacy repair)", async () => {
			conversation(account("b"), ID);
			expect(await select({ panes: [pane({ sessionId: ID })] })).toEqual([expect.objectContaining({ kind: "selected", codexHome: realpathSync(account("b")) })]);
		});
	});

	describe("run boundary", () => {
		const boundary = (lifecycleStartedAt: string | null, worktreeBirthMs: number | null, floorAt: string | null = null) => ({ lifecycleStartedAt, worktreeBirthMs, floorAt });
		const minutes = (m: number) => RUN_START + m * 60_000;

		it("rejects a discarded run's conversation after a reset, even written again: the start decides, not the mtime", async () => {
			const old = conversation(account("a"), ID, {}, -120);
			const afterReset = boundary(new Date(minutes(0)).toISOString(), minutes(0));
			expect(await picked({ runBoundary: afterReset })).toEqual(["none"]);
			touch(old);
			expect(await picked({ runBoundary: afterReset })).toEqual(["none"]);
		});

		it("accepts a legacy conversation started before the stamp but after the folder, and one whose folder was recreated mid-run", async () => {
			conversation(account("a"), ID, {}, 10);
			expect(await picked({ runBoundary: boundary(new Date(minutes(30)).toISOString(), minutes(0)) })).toEqual([ID]);
			expect(await picked({ runBoundary: boundary(new Date(minutes(0)).toISOString(), minutes(50)) })).toEqual([ID]);
		});

		it("with no stamp, the folder alone bounds the scan; with neither (missing birthtime), nothing is scanned", async () => {
			conversation(account("a"), ID, {}, -200);
			expect(await picked({ runBoundary: boundary(null, minutes(0)) })).toEqual(["none"]);
			rmSync(account("a"), { recursive: true });
			conversation(account("a"), ID, {}, 10);
			expect(await picked({ runBoundary: boundary(null, 0) })).toEqual(["none"]);
			expect(await picked({ runBoundary: boundary(null, null) })).toEqual(["none"]);
		});

		it("after a reset/completion/restart, restored folder times cannot bring the ended run back", async () => {
			// The run ended at minute 60 and wrote the floor; a time-preserving restore
			// then dragged the folder's birth back before that run began.
			conversation(account("a"), ID, {}, 20);
			expect(await picked({ runBoundary: boundary(new Date(minutes(70)).toISOString(), minutes(-500), new Date(minutes(60)).toISOString()) })).toEqual(["none"]);
		});

		it("after the floor, a session of the next run is taken whether or not folder times were restored", async () => {
			conversation(account("a"), ID, {}, 20);
			conversation(account("a"), OTHER, {}, 75);
			for (const birth of [minutes(-500), minutes(70)]) {
				expect(await picked({ runBoundary: boundary(new Date(minutes(70)).toISOString(), birth, new Date(minutes(60)).toISOString()) }), `birth ${birth}`).toEqual([OTHER]);
			}
		});

		it("never applies the boundary to a saved id", async () => {
			conversation(account("a"), ID, {}, -500);
			expect(await picked({ panes: [pane({ sessionId: ID })], runBoundary: boundary(new Date(minutes(70)).toISOString(), minutes(70), new Date(minutes(60)).toISOString()) })).toEqual([ID]);
		});

		it("an absent floor (older data) leaves the boundary to the stamp and the folder", () => {
			expect(codexScanBound(boundary(new Date(minutes(30)).toISOString(), minutes(0)))).toBe(minutes(0));
			expect(codexScanBound({ lifecycleStartedAt: new Date(minutes(30)).toISOString(), worktreeBirthMs: minutes(0), floorAt: undefined })).toBe(minutes(0));
			expect(codexScanBound(boundary(new Date(minutes(30)).toISOString(), minutes(0), new Date(minutes(40)).toISOString()))).toBe(minutes(40));
		});
	});

	it("hands back a store resolveCodexResumeHome agrees with", async () => {
		conversation(account("original"), ID);
		const [result] = await select({ additionalHomes: [account("default")] });
		expect(result).toMatchObject({ kind: "selected", sessionId: ID });
		expect(await resolveCodexResumeHome(ID, [account("default")], home)).toBe((result as { codexHome: string }).codexHome);
	});

});

describe("isInteractiveCodexConversation", () => {
	function rolloutWith(root: string, id: string, payload: Record<string, unknown>) {
		const path = join(root, "sessions", "2026", "09", "12", `rollout-x-${id}.jsonl`);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: { id, cwd: "/w", source: "cli", ...payload } })}\n`);
	}

	it("says not yet while the rollout does not exist, then accepts the user's own TUI conversation", async () => {
		expect(await isInteractiveCodexConversation(ID, [], home)).toBe(false);
		rolloutWith(account("a"), ID, {});
		expect(await isInteractiveCodexConversation(ID, [], home)).toBe(true);
	});

	it("rejects a subagent and a codex exec run", async () => {
		rolloutWith(account("a"), ID, { thread_source: "subagent" });
		expect(await isInteractiveCodexConversation(ID, [], home)).toBe(false);
		rolloutWith(account("a"), ID, { source: "exec" });
		expect(await isInteractiveCodexConversation(ID, [], home)).toBe(false);
	});

	it("rejects a malformed id without touching any store", async () => {
		fsGuard.roots = [];
		expect(await isInteractiveCodexConversation("codex-sess-2", [], home)).toBe(false);
		expect(fsGuard.violations).toEqual([]);
		fsGuard.roots = [home, realpathSync(home)];
	});
});
