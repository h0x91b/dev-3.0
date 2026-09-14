import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveCodexResumeHome } from "../codex-resume-home";

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
