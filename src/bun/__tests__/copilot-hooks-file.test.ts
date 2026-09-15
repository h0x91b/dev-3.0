import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AGENT_STATUS_HOOK_EVENTS,
	buildCopilotHooks,
	COPILOT_SETTINGS_FILE,
	COPILOT_STATUS_HOOK_EVENTS,
	copilotHookCommand,
	ensureCopilotTrustedFolder,
	mergeCopilotHooks,
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
		const built = buildCopilotHooks(POSIX);
		expect(Object.keys(built).sort()).toEqual(Object.keys(COPILOT_STATUS_HOOK_EVENTS).sort());
		for (const entries of Object.values(built)) {
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({ type: "command", timeoutSec: 5 });
		}
	});
});

describe("mergeCopilotHooks", () => {
	it("keeps a foreign hook on the same event and replaces only dev3's", () => {
		const foreign = { type: "command", bash: "/opt/corp/enforcer --editor github_copilot" };
		const first = mergeCopilotHooks({ hooks: { preToolUse: [foreign] } }, POSIX);
		const second = mergeCopilotHooks(first, POSIX);

		const entries = (second.hooks as Record<string, unknown[]>).preToolUse;
		expect(entries[0]).toEqual(foreign);
		// Re-merging must not stack a second dev3 copy beside the first.
		expect(entries).toHaveLength(2);
	});

	it("leaves unrelated settings alone", () => {
		const merged = mergeCopilotHooks({ theme: "dark", banner: "never" }, POSIX);
		expect(merged).toMatchObject({ theme: "dark", banner: "never" });
	});
});

describe("ensureCopilotTrustedFolder", () => {
	it("appends once and never drops a folder the user trusted", () => {
		const first = ensureCopilotTrustedFolder({ trustedFolders: ["/home/mine"] }, "/w/t");
		expect(first.trustedFolders).toEqual(["/home/mine", "/w/t"]);
		expect(ensureCopilotTrustedFolder(first, "/w/t")).toEqual(first);
	});

	it("survives a settings file with no trustedFolders key", () => {
		expect(ensureCopilotTrustedFolder({}, "/w/t").trustedFolders).toEqual(["/w/t"]);
	});
});

describe("writeCopilotHooks", () => {
	// `~/.copilot/hooks/` can be root-owned on a managed machine (an MDM drops its
	// policy hook there), so dev3 writes nothing inside it — settings.json is the
	// file Copilot itself maintains as the user.
	it("writes settings.json in the Copilot home and touches no hooks/ dir", () => {
		const home = mkdtempSync(join(tmpdir(), "copilot-home-"));
		expect(writeCopilotHooks(home)).toBe(true);

		const written = JSON.parse(readFileSync(join(home, COPILOT_SETTINGS_FILE), "utf-8"));
		expect(Object.keys(written.hooks)).toContain("sessionStart");
		expect(existsSync(join(home, "hooks"))).toBe(false);
	});

	it("preserves the user's own settings and is idempotent", () => {
		const home = mkdtempSync(join(tmpdir(), "copilot-home-"));
		const path = join(home, COPILOT_SETTINGS_FILE);
		writeFileSync(path, JSON.stringify({ theme: "dark", trustedFolders: ["/mine"] }), "utf-8");

		expect(writeCopilotHooks(home)).toBe(true);
		expect(writeCopilotHooks(home)).toBe(false);

		const written = JSON.parse(readFileSync(path, "utf-8"));
		expect(written.theme).toBe("dark");
		expect(written.trustedFolders).toEqual(["/mine"]);
	});
});

describe("resolveCopilotHome", () => {
	it("honours COPILOT_HOME rather than relocating the user's config", () => {
		expect(resolveCopilotHome({ COPILOT_HOME: "/custom/copilot" })).toBe("/custom/copilot");
		expect(resolveCopilotHome({ COPILOT_HOME: "   " })).toMatch(/[/\\]\.copilot$/);
		expect(resolveCopilotHome({})).toMatch(/[/\\]\.copilot$/);
	});
});
