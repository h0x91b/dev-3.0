import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPiStatusExtension, piStatusExtensionPath, writePiStatusExtension } from "../../shared/pi-status-extension";
import { buildOmpStatusExtension } from "../../shared/omp-status-extension";
import { AGENT_STATUS_HOOK_EVENTS } from "../../shared/agent-hooks";

const isWindows = process.platform === "win32";

let tempHome: string;
beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "dev3-pi-ext-"));
});
afterEach(() => {
	rmSync(tempHome, { recursive: true, force: true });
});

describe("buildPiStatusExtension", () => {
	it("spawns `hook pi`, is inert outside a task pane, and stays apart from omp's module", () => {
		const body = buildPiStatusExtension({ cli: "/x/dev3" });
		expect(body).toContain('["hook", "pi"]');
		expect(body).toContain("if (!process.env.DEV3_TASK_ID) return;");
		expect(body).not.toBe(buildOmpStatusExtension({ cli: "/x/dev3" }));
	});

	it("subscribes only to events plain pi defines, and reports only accepted events", () => {
		const body = buildPiStatusExtension({ cli: "/x/dev3" });
		for (const name of body.matchAll(/report(?:Working|Idle)?\(ctx, "([A-Za-z]+)"/g)) {
			expect(AGENT_STATUS_HOOK_EVENTS).toContain(name[1]);
		}
		const subscribed = [...body.matchAll(/pi\.on\("([a-z_]+)"/g)].map((m) => m[1]);
		expect(subscribed).toEqual([
			"session_start",
			"input",
			"agent_start",
			"tool_execution_start",
			"tool_execution_end",
			"ui_prompt_start",
			"ui_prompt_end",
			"agent_settled",
		]);
		// omp-only events: plain pi has no approval tiers, and agent_end is not final there.
		expect(body).not.toContain("tool_approval");
		expect(body).not.toContain('pi.on("agent_end"');
	});

	it("is written under <dev3 home>/data/agent-hooks/pi-status.ts", () => {
		const path = writePiStatusExtension({ dev3Home: tempHome, cli: "/x/dev3" });
		expect(path).toBe(piStatusExtensionPath(tempHome));
		expect(path).toBe(join(tempHome, "data", "agent-hooks", "pi-status.ts"));
		expect(readFileSync(path, "utf-8")).toBe(buildPiStatusExtension({ cli: "/x/dev3" }));
	});
});

/** The generated module executed for real against a stand-in CLI, as pi loads it. */
describe.skipIf(isWindows)("the generated pi extension at runtime", () => {
	async function load() {
		const log = join(tempHome, "reports.log");
		const cli = join(tempHome, "fake-dev3");
		writeFileSync(cli, `#!/bin/sh\n[ "$1" = hook ] && [ "$2" = pi ] || exit 9\ncat >> "${log}"\nprintf '\\n' >> "${log}"\n`);
		chmodSync(cli, 0o755);
		const path = writePiStatusExtension({ dev3Home: tempHome, cli });

		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const pi = { on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler) };
		process.env.DEV3_TASK_ID = "task-under-test";
		const mod = await import(/* @vite-ignore */ `${path}?t=${Date.now()}`) as { default: (pi: unknown) => void };
		mod.default(pi);

		const ctx = { cwd: tempHome, sessionManager: { getSessionId: () => "sess-1" } };
		const reports = async () => {
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
			fire: async (event: string, payload: unknown) => { await handlers.get(event)?.(payload, ctx); },
			reports,
		};
	}

	afterEach(() => {
		delete process.env.DEV3_TASK_ID;
	});

	it("maps a turn onto the status vocabulary and stops only when pi settles", async () => {
		const h = await load();
		await h.fire("session_start", { type: "session_start", reason: "startup" });
		await h.fire("input", { type: "input", text: "fix the bug", source: "interactive" });
		await h.fire("agent_start", { type: "agent_start" });
		await h.fire("tool_execution_start", { toolName: "bash" });
		await h.fire("agent_end", { messages: [] });
		await h.fire("tool_execution_end", { toolName: "bash" });
		await h.fire("agent_settled", { aborted: false });

		const reports = await h.reports();
		expect(reports.map((r) => r.event)).toEqual(["SessionStart", "UserPromptSubmit", "Stop"]);
		expect(reports.every((r) => r.sessionId === "sess-1")).toBe(true);
		expect(reports[1]!.prompt).toBe("fix the bug");
		expect(typeof reports[1]!.submissionId).toBe("string");
	});

	it("parks on an extension's blocking prompt and goes back to work mid-run", async () => {
		const h = await load();
		await h.fire("session_start", {});
		await h.fire("agent_start", {});
		await h.fire("ui_prompt_start", { kind: "confirm" });
		await h.fire("ui_prompt_end", { kind: "confirm" });
		await h.fire("agent_settled", { aborted: false });

		expect((await h.reports()).map((r) => r.event))
			.toEqual(["SessionStart", "UserPromptSubmit", "PermissionRequest", "PostToolUse", "Stop"]);
	});

	it("settles again when a prompt is answered while pi is idle", async () => {
		const h = await load();
		await h.fire("session_start", {});
		await h.fire("ui_prompt_start", { kind: "select" });
		await h.fire("ui_prompt_end", { kind: "select" });

		expect((await h.reports()).map((r) => r.event)).toEqual(["SessionStart", "PermissionRequest", "Stop"]);
	});

	it("does not forward an extension-sourced input as the human's prompt", async () => {
		const h = await load();
		await h.fire("session_start", {});
		await h.fire("input", { text: "[from peer] hi", source: "extension" });

		const reports = await h.reports();
		expect(reports.map((r) => r.event)).toEqual(["SessionStart", "UserPromptSubmit"]);
		expect(reports[1]).not.toHaveProperty("prompt");
	});
});
