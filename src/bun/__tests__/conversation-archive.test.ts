/**
 * The archive written when a task goes terminal. It is the only copy that
 * survives both the worktree removal and Claude's own retention window, so
 * "wrote nothing and said nothing" is the failure to guard against.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, Task } from "../../shared/types";
import { claudeEncodePath } from "../../shared/conversation-search-core";

let home: string;
let container: string;

vi.mock("../git", () => ({
	taskDir: () => container,
	virtualWorkDir: () => join(container, "work"),
}));

import { dumpTerminalTaskConversations } from "../conversation-archive";

const PROJECT = { id: "p1", path: "/code/dev-3.0", kind: "git" } as Project;

function task(over: Partial<Task> = {}): Task {
	return { id: "abcd1234-0000", worktreePath: join(container, "worktree"), ...over } as Task;
}

function seedTranscript(workingDir: string): void {
	const dir = join(home, ".claude", "projects", claudeEncodePath(workingDir));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "sess-1.jsonl"), [
		JSON.stringify({ type: "ai-title", aiTitle: "Archived work", sessionId: "sess-1" }),
		JSON.stringify({
			type: "user",
			sessionId: "sess-1",
			uuid: "u1",
			cwd: workingDir,
			timestamp: "2026-08-20T10:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "the retention window will eat this" }] },
		}),
	].join("\n") + "\n");
}

let originalHome: string | undefined;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "convarchive-"));
	container = join(home, ".dev3.0", "worktrees", "code-dev-3-0", "abcd1234");
	mkdirSync(join(container, "worktree"), { recursive: true });
	originalHome = process.env.HOME;
	process.env.HOME = home;
});

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	rmSync(home, { recursive: true, force: true });
});

describe("dumpTerminalTaskConversations", () => {
	it("writes the task's conversation into its own container, outside the worktree", async () => {
		seedTranscript(join(container, "worktree"));

		const written = await dumpTerminalTaskConversations(PROJECT, task());

		expect(written).toHaveLength(1);
		expect(written[0]).toBe(join(container, "conversations", "claude-sess-1.json"));
		expect(existsSync(written[0])).toBe(true);
		const dump = JSON.parse(readFileSync(written[0], "utf-8")) as { title: string };
		expect(dump.title).toBe("Archived work");
	});

	it("uses the derived path when a completed task no longer carries its worktree", async () => {
		seedTranscript(join(container, "worktree"));

		const written = await dumpTerminalTaskConversations(
			PROJECT,
			task({ worktreePath: null }),
			join(container, "worktree"),
		);

		expect(written).toHaveLength(1);
	});

	it("writes nothing, and does not throw, when the task has no transcript", async () => {
		expect(await dumpTerminalTaskConversations(PROJECT, task())).toEqual([]);
		expect(existsSync(join(container, "conversations"))).toBe(false);
	});

	it("does not re-dump its own output", async () => {
		seedTranscript(join(container, "worktree"));
		await dumpTerminalTaskConversations(PROJECT, task());
		await dumpTerminalTaskConversations(PROJECT, task());
		expect(readdirSync(join(container, "conversations"))).toEqual(["claude-sess-1.json"]);
	});
});
