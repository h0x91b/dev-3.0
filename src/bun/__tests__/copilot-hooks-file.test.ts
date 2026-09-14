import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AGENT_STATUS_HOOK_EVENTS,
	buildCopilotHooks,
	COPILOT_DEV3_HOOKS_FILE,
	COPILOT_HOOKS_DIR,
	COPILOT_STATUS_HOOK_EVENTS,
	copilotHookCommand,
	writeCopilotHooks,
} from "../../shared/agent-hooks";
import { resolveCopilotHome } from "../copilot-config";

const POSIX = { cli: "~/.dev3.0/bin/dev3", posixShell: true } as const;
const WINDOWS = { cli: "C:/Users/me/.dev3.0/bin/dev3.exe", posixShell: false } as const;

describe("Copilot hook event mapping", () => {
	it("every Copilot event stands for a real generic status event", () => {
		for (const generic of Object.values(COPILOT_STATUS_HOOK_EVENTS)) {
			expect(AGENT_STATUS_HOOK_EVENTS).toContain(generic);
		}
	});

	// Copilot 1.0.83 fires permissionRequest on every permission evaluation,
	// including ones --allow-all-tools approves without showing the user anything.
	// Subscribing would park a working task in Has Questions on its first tool call.
	it("does not subscribe to permissionRequest", () => {
		expect(Object.keys(COPILOT_STATUS_HOOK_EVENTS)).not.toContain("permissionRequest");
	});
});

describe("copilotHookCommand", () => {
	it("POSIX skips without spawning anything outside a dev3 task", () => {
		expect(copilotHookCommand("preToolUse", POSIX)).toEqual({
			bash: `[ -z "$DEV3_TASK_ID" ] || exec ~/.dev3.0/bin/dev3 hook copilot preToolUse`,
		});
	});

	it("Windows gets a PowerShell form that always exits 0", () => {
		const command = copilotHookCommand("agentStop", WINDOWS);
		expect(command).toEqual({
			powershell: `if ($env:DEV3_TASK_ID) { & C:/Users/me/.dev3.0/bin/dev3.exe hook copilot agentStop }; exit 0`,
		});
		// Fail-closed on preToolUse: any non-zero exit blocks the tool call, so the
		// guard must never be the thing that fails.
		expect((command as { powershell: string }).powershell).toContain("exit 0");
	});

	it("emits only this machine's dialect — the file is machine-local", () => {
		expect(copilotHookCommand("sessionStart", POSIX)).not.toHaveProperty("powershell");
		expect(copilotHookCommand("sessionStart", WINDOWS)).not.toHaveProperty("bash");
	});
});

describe("buildCopilotHooks", () => {
	it("declares one command entry per subscribed event", () => {
		const built = buildCopilotHooks(POSIX) as { version: number; hooks: Record<string, unknown[]> };
		expect(built.version).toBe(1);
		expect(Object.keys(built.hooks).sort()).toEqual(Object.keys(COPILOT_STATUS_HOOK_EVENTS).sort());
		for (const entries of Object.values(built.hooks)) {
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({ type: "command", timeoutSec: 5 });
		}
	});
});

describe("writeCopilotHooks", () => {
	it("writes dev3's own file and leaves a neighbouring hook file untouched", () => {
		const home = mkdtempSync(join(tmpdir(), "copilot-home-"));
		const dir = join(home, COPILOT_HOOKS_DIR);
		mkdirSync(dir, { recursive: true });
		const foreign = join(dir, "policy-enforcer.json");
		writeFileSync(foreign, '{"version":1,"hooks":{}}', "utf-8");

		expect(writeCopilotHooks(home)).toBe(true);

		const written = JSON.parse(readFileSync(join(dir, COPILOT_DEV3_HOOKS_FILE), "utf-8"));
		expect(Object.keys(written.hooks)).toContain("sessionStart");
		expect(readFileSync(foreign, "utf-8")).toBe('{"version":1,"hooks":{}}');
	});

	it("is idempotent — an unchanged file is not rewritten", () => {
		const home = mkdtempSync(join(tmpdir(), "copilot-home-"));
		expect(writeCopilotHooks(home)).toBe(true);
		expect(writeCopilotHooks(home)).toBe(false);
	});
});

describe("resolveCopilotHome", () => {
	it("honours COPILOT_HOME rather than relocating the user's config", () => {
		expect(resolveCopilotHome({ COPILOT_HOME: "/custom/copilot" })).toBe("/custom/copilot");
		expect(resolveCopilotHome({ COPILOT_HOME: "   " })).toMatch(/[/\\]\.copilot$/);
		expect(resolveCopilotHome({})).toMatch(/[/\\]\.copilot$/);
	});
});
