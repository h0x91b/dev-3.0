import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("../../spawn", () => ({ spawn: h.spawnMock }));

import { getClaudeModStatus, setClaudeModEnabled } from "../claude-mods";

type Reply = { exitCode?: number; stdout?: string; stderr?: string };

/** Answers each `claude …` run by its joined args; records every call. */
function stubClaude(replies: Record<string, Reply>) {
	h.spawnMock.mockImplementation((cmd: string[]) => {
		const key = cmd.slice(1).join(" ");
		const reply = replies[key] ?? { exitCode: 0, stdout: "" };
		return {
			stdout: reply.stdout ?? "",
			stderr: reply.stderr ?? "",
			exited: Promise.resolve(reply.exitCode ?? 0),
		};
	});
}

function calls(): string[] {
	return h.spawnMock.mock.calls.map(([cmd]: [string[]]) => cmd.slice(1).join(" "));
}

const LIST = "plugin list --json";
const MARKETPLACES = "plugin marketplace list --json";
const installedList = (enabled: boolean) =>
	JSON.stringify([{ id: "prismantis@prismantis", version: "0.36.0", scope: "user", enabled }]);

beforeEach(() => {
	vi.clearAllMocks();
});

describe("getClaudeModStatus", () => {
	it("reports an installed, enabled user-scope plugin with its version", async () => {
		stubClaude({ [LIST]: { stdout: installedList(true) } });
		expect(await getClaudeModStatus("prismantis")).toEqual({
			modId: "prismantis",
			claudeAvailable: true,
			installed: true,
			enabled: true,
			version: "0.36.0",
		});
	});

	it("ignores a project-scope install", async () => {
		stubClaude({ [LIST]: { stdout: JSON.stringify([{ id: "prismantis@prismantis", scope: "project", enabled: true }]) } });
		expect((await getClaudeModStatus("prismantis")).installed).toBe(false);
	});

	it("reports the CLI unavailable when `claude plugin list` fails", async () => {
		stubClaude({ [LIST]: { exitCode: 127 } });
		expect((await getClaudeModStatus("prismantis")).claudeAvailable).toBe(false);
	});

	it("throws on an unknown mod", async () => {
		await expect(getClaudeModStatus("nope")).rejects.toThrow("Unknown Claude mod");
	});
});

describe("setClaudeModEnabled", () => {
	it("adds the marketplace and installs when nothing is there yet", async () => {
		stubClaude({ [LIST]: { stdout: "[]" }, [MARKETPLACES]: { stdout: "[]" } });
		await setClaudeModEnabled("prismantis", true);
		expect(calls()).toContain("plugin marketplace add NahumLitvin/prismantis");
		expect(calls()).toContain("plugin install prismantis@prismantis");
		expect(calls()).not.toContain("plugin marketplace update prismantis");
	});

	it("refreshes the marketplace, updates and re-enables a disabled install", async () => {
		stubClaude({ [LIST]: { stdout: installedList(false) }, [MARKETPLACES]: { stdout: JSON.stringify([{ name: "prismantis" }]) } });
		await setClaudeModEnabled("prismantis", true);
		const ran = calls();
		expect(ran).toContain("plugin marketplace update prismantis");
		expect(ran.indexOf("plugin update prismantis@prismantis")).toBeGreaterThan(ran.indexOf("plugin marketplace update prismantis"));
		expect(ran).toContain("plugin enable prismantis@prismantis");
		expect(ran).not.toContain("plugin install prismantis@prismantis");
	});

	it("never auto-accepts a marketplace-declared command", async () => {
		stubClaude({ [LIST]: { stdout: "[]" }, [MARKETPLACES]: { stdout: "[]" } });
		await setClaudeModEnabled("prismantis", true);
		expect(calls().some((c) => / -y\b|--yes|--accept-command/.test(c))).toBe(false);
	});

	it("uninstalls keeping the plugin's data when turned off", async () => {
		stubClaude({ [LIST]: { stdout: installedList(true) } });
		await setClaudeModEnabled("prismantis", false);
		expect(calls()).toContain("plugin uninstall prismantis@prismantis --keep-data");
	});

	it("does nothing when turned off and not installed", async () => {
		stubClaude({ [LIST]: { stdout: "[]" } });
		await setClaudeModEnabled("prismantis", false);
		expect(calls().filter((c) => c !== LIST)).toEqual([]);
	});

	it("surfaces the CLI's error and lets the next change run", async () => {
		stubClaude({
			[LIST]: { stdout: "[]" },
			[MARKETPLACES]: { stdout: "[]" },
			"plugin marketplace add NahumLitvin/prismantis": { exitCode: 1, stderr: "network unreachable" },
		});
		await expect(setClaudeModEnabled("prismantis", true)).rejects.toThrow("network unreachable");
		stubClaude({ [LIST]: { stdout: "[]" } });
		await expect(setClaudeModEnabled("prismantis", false)).resolves.toMatchObject({ installed: false });
	});

	it("refuses to change anything when the CLI is missing", async () => {
		stubClaude({ [LIST]: { exitCode: 127 } });
		await expect(setClaudeModEnabled("prismantis", true)).rejects.toThrow("not found");
		expect(calls()).toEqual([LIST]);
	});
});
