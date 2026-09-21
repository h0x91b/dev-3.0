import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildOmpStatusExtension,
	ompStatusExtensionPath,
	ompStatusHookCli,
	writeOmpStatusExtension,
} from "../../shared/omp-status-extension";
import { AGENT_STATUS_HOOK_EVENTS } from "../../shared/agent-hooks";

const isWindows = process.platform === "win32";

let tempHome: string;
beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "dev3-omp-ext-"));
});
afterEach(() => {
	rmSync(tempHome, { recursive: true, force: true });
});

describe("buildOmpStatusExtension", () => {
	it("bakes the CLI path in as a JSON string and spawns `hook omp`", () => {
		const body = buildOmpStatusExtension({ cli: "C:\\Users\\u\\.dev3.0\\bin\\dev3.exe" });
		expect(body).toContain('const DEV3_CLI = "C:\\\\Users\\\\u\\\\.dev3.0\\\\bin\\\\dev3.exe";');
		expect(body).toContain('["hook", "omp"]');
	});

	it("is inert outside a dev3 task pane", () => {
		expect(buildOmpStatusExtension({ cli: "/x/dev3" })).toContain("if (!process.env.DEV3_TASK_ID) return;");
	});

	it("reports only events the socket handler accepts", () => {
		const body = buildOmpStatusExtension({ cli: "/x/dev3" });
		for (const name of body.matchAll(/report(?:Working|Idle)?\(ctx, "([A-Za-z]+)"/g)) {
			expect(AGENT_STATUS_HOOK_EVENTS).toContain(name[1]);
		}
		// Every lifecycle the board needs has a subscriber.
		for (const event of [
			"session_start",
			"input",
			"agent_start",
			"tool_execution_start",
			"tool_execution_end",
			"tool_approval_requested",
			"tool_approval_resolved",
			"agent_end",
		]) {
			expect(body).toContain(`pi.on("${event}"`);
		}
	});
});

describe("ompStatusHookCli", () => {
	it("is an absolute path on POSIX, under the dev3 home", () => {
		const cli = ompStatusHookCli({ platform: "linux" });
		expect(cli.endsWith("/.dev3.0/bin/dev3")).toBe(true);
		expect(cli.startsWith("~")).toBe(false);
	});

	it("uses the Windows CLI lookup on win32", () => {
		expect(ompStatusHookCli({ platform: "win32", execDir: "C:\\app", exists: (p) => p === "C:\\app\\cli\\dev3.exe" }))
			.toBe("C:\\app\\cli\\dev3.exe");
	});
});

describe("writeOmpStatusExtension", () => {
	it("writes the module under <dev3 home>/data/agent-hooks and returns its path", () => {
		const path = writeOmpStatusExtension({ dev3Home: tempHome, cli: "/x/dev3" });
		expect(path).toBe(ompStatusExtensionPath(tempHome));
		expect(path).toBe(join(tempHome, "data", "agent-hooks", "omp-status.ts"));
		expect(readFileSync(path, "utf-8")).toBe(buildOmpStatusExtension({ cli: "/x/dev3" }));
	});

	it("leaves an up-to-date file untouched and replaces a stale one", () => {
		const path = writeOmpStatusExtension({ dev3Home: tempHome, cli: "/x/dev3" });
		const inode = statSync(path).ino;
		writeOmpStatusExtension({ dev3Home: tempHome, cli: "/x/dev3" });
		expect(statSync(path).ino).toBe(inode);

		writeOmpStatusExtension({ dev3Home: tempHome, cli: "/y/dev3" });
		expect(readFileSync(path, "utf-8")).toContain('"/y/dev3"');
		expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
	});
});

/**
 * The generated module, executed for real: imported like omp imports it, handed a
 * fake `pi`, and pointed at a stand-in CLI that appends each stdin payload to a
 * log. This is what proves the event mapping, the serial delivery order and the
 * working-state throttle — a string assertion on the template cannot.
 */
describe.skipIf(isWindows)("the generated extension at runtime", () => {
	interface Harness {
		fire: (event: string, payload: unknown, ctx?: unknown) => Promise<void>;
		reports: () => Promise<Array<Record<string, unknown>>>;
		ctx: { cwd: string; sessionManager: { getSessionId: () => string } };
	}

	async function load(): Promise<Harness> {
		const log = join(tempHome, "reports.log");
		const cli = join(tempHome, "fake-dev3");
		writeFileSync(cli, `#!/bin/sh\n[ "$1" = hook ] && [ "$2" = omp ] || exit 9\ncat >> "${log}"\nprintf '\\n' >> "${log}"\n`);
		chmodSync(cli, 0o755);
		const path = writeOmpStatusExtension({ dev3Home: tempHome, cli });

		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const pi = { on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler), logger: { warn: () => {} } };
		process.env.DEV3_TASK_ID = "task-under-test";
		const mod = await import(/* @vite-ignore */ `${path}?t=${Date.now()}`) as { default: (pi: unknown) => void };
		mod.default(pi);

		const ctx = { cwd: tempHome, sessionManager: { getSessionId: () => "sess-1" } };
		const reports = async () => {
			// The extension never blocks omp on a report, so wait for the queue to drain.
			const deadline = Date.now() + 5_000;
			let last = "";
			while (Date.now() < deadline) {
				const text = existsSync(log) ? readFileSync(log, "utf-8") : "";
				if (text === last && text !== "") break;
				last = text;
				await new Promise((r) => setTimeout(r, 150));
			}
			return last.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
		};
		return {
			ctx,
			fire: async (event, payload, c = ctx) => { await handlers.get(event)?.(payload, c); },
			reports,
		};
	}

	afterEach(() => {
		delete process.env.DEV3_TASK_ID;
	});

	it("maps a full turn onto the status vocabulary, in order, with the session id", async () => {
		const h = await load();
		await h.fire("session_start", { type: "session_start" });
		await h.fire("input", { type: "input", text: "fix the bug", source: "interactive" });
		await h.fire("agent_start", { type: "agent_start" });
		await h.fire("tool_execution_start", { toolName: "bash" });
		await h.fire("tool_execution_end", { toolName: "bash" });
		await h.fire("agent_end", { messages: [] });

		const reports = await h.reports();
		expect(reports.map((r) => r.event)).toEqual(["SessionStart", "UserPromptSubmit", "Stop"]);
		expect(reports.every((r) => r.sessionId === "sess-1")).toBe(true);
		const prompt = reports[1]!;
		expect(prompt.prompt).toBe("fix the bug");
		expect(typeof prompt.submissionId).toBe("string");
		expect((prompt.submissionId as string).length).toBeGreaterThan(8);
	});

	it("parks on an approval and resumes on the next tool activity", async () => {
		const h = await load();
		await h.fire("session_start", {});
		await h.fire("tool_approval_requested", { sessionId: "sess-1", toolName: "bash" });
		await h.fire("tool_approval_resolved", { sessionId: "sess-1", approved: true });
		await h.fire("tool_execution_start", { toolName: "bash" });
		await h.fire("agent_end", { messages: [] });

		expect((await h.reports()).map((r) => r.event))
			.toEqual(["SessionStart", "PermissionRequest", "PostToolUse", "Stop"]);
	});

	it("ignores another session's approval and an agent_end omp will continue from", async () => {
		const h = await load();
		await h.fire("session_start", {});
		await h.fire("tool_approval_requested", { sessionId: "someone-else", toolName: "bash" });
		await h.fire("agent_end", { messages: [], willContinue: true });
		await h.fire("agent_end", { messages: [] });

		expect((await h.reports()).map((r) => r.event)).toEqual(["SessionStart", "Stop"]);
	});

	it("does not forward an extension-sourced input as the human's prompt", async () => {
		const h = await load();
		await h.fire("session_start", {});
		await h.fire("agent_end", { messages: [] });
		await h.fire("input", { text: "[from peer] hi", source: "extension" });

		const reports = await h.reports();
		expect(reports.map((r) => r.event)).toEqual(["SessionStart", "Stop", "UserPromptSubmit"]);
		expect(reports[2]).not.toHaveProperty("prompt");
		expect(reports[2]).not.toHaveProperty("submissionId");
	});
});
