import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	spawnMock: vi.fn(),
	claudeHome: "",
	accountDirs: [] as string[],
}));
vi.mock("../../spawn", () => ({ spawn: h.spawnMock }));
vi.mock("../../agent-accounts", () => ({
	defaultAccountPaths: () => ({ claudeHome: h.claudeHome }),
	listClaudeAccountDirs: () => h.accountDirs,
}));

import { CLAUDE_COMMAND_TIMEOUT_MS, getClaudeModStatus, setClaudeModEnabled } from "../claude-mods";

const PINNED_SOURCE = "https://github.com/NahumLitvin/prismantis.git#v0.41.0";

interface DirState {
	marketplace: { url: string; ref?: string } | null;
	plugin: { version: string; enabled: boolean } | null;
}

/** A stand-in `claude` that keeps plugin state per config dir and logs every run. */
class FakeClaude {
	dirs = new Map<string, DirState>();
	log: string[] = [];
	failOn: Record<string, string> = {};
	hangOn: string | null = null;
	missing = false;
	kill = vi.fn();

	state(dir = "default"): DirState {
		if (!this.dirs.has(dir)) this.dirs.set(dir, { marketplace: null, plugin: null });
		return this.dirs.get(dir)!;
	}

	run(args: string[], env: Record<string, string | undefined>) {
		const dir = env.CLAUDE_CONFIG_DIR;
		const key = args.join(" ");
		this.log.push(dir ? `[${basename(dir)}] ${key}` : key);
		const s = this.state(dir ?? "default");
		const reply = (stdout = "", exitCode = 0, stderr = "") => ({ stdout, stderr, exited: Promise.resolve(exitCode), kill: this.kill });
		if (this.missing) return reply("", 127);
		if (this.hangOn === key) return { stdout: "", stderr: "", exited: new Promise<number>(() => {}), kill: this.kill };
		if (this.failOn[key]) return reply("", 1, this.failOn[key]);

		if (key === "plugin list --json") {
			return reply(JSON.stringify(s.plugin ? [{ id: "prismantis@prismantis", scope: "user", ...s.plugin }] : []));
		}
		if (key === "plugin marketplace list --json") {
			return reply(JSON.stringify(s.marketplace ? [{ name: "prismantis", ...s.marketplace }] : []));
		}
		if (args[2] === "add") {
			const [url, ref] = args[3].split("#");
			s.marketplace = { url, ref };
		} else if (args[2] === "remove") {
			s.marketplace = null;
			s.plugin = null;
		} else if (args[1] === "install") {
			s.plugin = { version: s.marketplace?.ref === "v0.41.0" ? "0.40.0" : "0.41.0", enabled: true };
		} else if (args[1] === "uninstall") s.plugin = null;
		else if (args[1] === "enable" && s.plugin) s.plugin.enabled = true;
		else if (args[1] === "disable" && s.plugin) s.plugin.enabled = false;
		return reply();
	}
}

let fake: FakeClaude;
let root: string;

beforeEach(() => {
	vi.clearAllMocks();
	fake = new FakeClaude();
	h.spawnMock.mockImplementation((cmd: string[], opts: { env: Record<string, string | undefined> }) => fake.run(cmd.slice(1), opts.env));
	root = mkdtempSync(join(tmpdir(), "claude-mods-"));
	h.claudeHome = join(root, ".claude");
	mkdirSync(join(h.claudeHome, "plugins"), { recursive: true });
	writeFileSync(join(h.claudeHome, "settings.json"), "{}");
	h.accountDirs = [];
});

afterEach(() => {
	vi.useRealTimers();
	rmSync(root, { recursive: true, force: true });
});

function account(name: string, layout: "linked" | "own-plugins" | "own-settings" | "empty"): string {
	const dir = join(root, name);
	mkdirSync(dir);
	if (layout === "linked" || layout === "own-settings") symlinkSync(join(h.claudeHome, "plugins"), join(dir, "plugins"));
	if (layout === "linked" || layout === "own-plugins") symlinkSync(join(h.claudeHome, "settings.json"), join(dir, "settings.json"));
	if (layout === "own-plugins") mkdirSync(join(dir, "plugins"));
	if (layout === "own-settings") writeFileSync(join(dir, "settings.json"), "{}");
	h.accountDirs.push(dir);
	return dir;
}

describe("getClaudeModStatus", () => {
	it("reports an installed, enabled plugin at the pinned version", async () => {
		fake.state().plugin = { version: "0.40.0", enabled: true };
		expect(await getClaudeModStatus("prismantis")).toEqual({
			modId: "prismantis",
			claudeAvailable: true,
			installed: true,
			enabled: true,
			version: "0.40.0",
			pinnedVersion: "0.40.0",
			current: true,
		});
	});

	it("flags an install that is not the pinned version", async () => {
		fake.state().plugin = { version: "0.41.0", enabled: true };
		expect(await getClaudeModStatus("prismantis")).toMatchObject({ installed: true, version: "0.41.0", current: false });
	});

	it("reports the CLI unavailable when `claude plugin list` fails", async () => {
		fake.missing = true;
		expect((await getClaudeModStatus("prismantis")).claudeAvailable).toBe(false);
	});

	it("is not installed while an account with its own plugins dir lacks it", async () => {
		fake.state().plugin = { version: "0.40.0", enabled: true };
		account("acct-own", "own-plugins");
		expect(await getClaudeModStatus("prismantis")).toMatchObject({ installed: false, version: "0.40.0" });
	});

	it("throws on an unknown mod", async () => {
		await expect(getClaudeModStatus("nope")).rejects.toThrow("Unknown Claude mod");
	});
});

describe("setClaudeModEnabled", () => {
	it("adds the pinned marketplace and installs the pinned version", async () => {
		const status = await setClaudeModEnabled("prismantis", true);
		expect(fake.log).toContain(`plugin marketplace add ${PINNED_SOURCE}`);
		expect(fake.log).toContain("plugin install prismantis@prismantis");
		expect(fake.log.some((c) => c.includes("marketplace update") || c.startsWith("plugin update"))).toBe(false);
		expect(status).toMatchObject({ installed: true, enabled: true, version: "0.40.0", current: true });
	});

	it("re-pins an unpinned marketplace and replaces a newer install with the pinned one", async () => {
		fake.state().marketplace = { url: "https://github.com/NahumLitvin/prismantis.git" };
		fake.state().plugin = { version: "0.41.0", enabled: true };
		await setClaudeModEnabled("prismantis", true);
		const ran = fake.log;
		expect(ran.indexOf("plugin marketplace remove prismantis")).toBeLessThan(ran.indexOf(`plugin marketplace add ${PINNED_SOURCE}`));
		expect(fake.state().plugin).toEqual({ version: "0.40.0", enabled: true });
	});

	it("only re-enables a disabled install that is already pinned", async () => {
		fake.state().marketplace = { url: "https://github.com/NahumLitvin/prismantis.git", ref: "v0.41.0" };
		fake.state().plugin = { version: "0.40.0", enabled: false };
		await setClaudeModEnabled("prismantis", true);
		expect(fake.log.filter((c) => !c.endsWith("--json"))).toEqual(["plugin enable prismantis@prismantis"]);
	});

	it("fails when the install does not land on the pinned version", async () => {
		fake.state().marketplace = { url: "https://github.com/NahumLitvin/prismantis.git", ref: "v0.41.0" };
		const original = fake.run.bind(fake);
		fake.run = (args, env) => {
			const result = original(args, env);
			if (args[1] === "install") fake.state().plugin = { version: "9.9.9", enabled: true };
			return result;
		};
		await expect(setClaudeModEnabled("prismantis", true)).rejects.toThrow("expected prismantis@prismantis 0.40.0");
	});

	it("installs into accounts that keep their own plugins or settings, and skips linked ones", async () => {
		account("acct-linked", "linked");
		account("acct-empty", "empty");
		account("acct-plugins", "own-plugins");
		account("acct-settings", "own-settings");
		await setClaudeModEnabled("prismantis", true);
		expect(fake.log).toContain("[acct-plugins] plugin install prismantis@prismantis");
		expect(fake.log).toContain("[acct-settings] plugin install prismantis@prismantis");
		expect(fake.log.some((c) => c.startsWith("[acct-linked]") || c.startsWith("[acct-empty]"))).toBe(false);
	});

	it("disables rather than uninstalls, so the plugin's options survive", async () => {
		fake.state().plugin = { version: "0.40.0", enabled: true };
		account("acct-plugins", "own-plugins");
		fake.state(join(root, "acct-plugins")).plugin = { version: "0.40.0", enabled: true };
		await setClaudeModEnabled("prismantis", false);
		expect(fake.log.filter((c) => !c.endsWith("--json"))).toEqual([
			"plugin disable prismantis@prismantis",
			"[acct-plugins] plugin disable prismantis@prismantis",
		]);
	});

	it("never passes an inherited CLAUDE_CONFIG_DIR to the default dir", async () => {
		const inherited = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = "/somewhere/else";
		try {
			await getClaudeModStatus("prismantis");
		} finally {
			if (inherited === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = inherited;
		}
		const [, opts] = h.spawnMock.mock.calls[0];
		expect(opts.env).toHaveProperty("CLAUDE_CONFIG_DIR", undefined);
		expect(opts.env.GIT_TERMINAL_PROMPT).toBe("0");
	});

	it("never auto-accepts a marketplace-declared command", async () => {
		await setClaudeModEnabled("prismantis", true);
		expect(fake.log.some((c) => / -y\b|--yes|--accept-command/.test(c))).toBe(false);
	});

	it("kills a stalled command and lets the next change run", async () => {
		vi.useFakeTimers();
		fake.hangOn = `plugin marketplace add ${PINNED_SOURCE}`;
		const stalled = setClaudeModEnabled("prismantis", true);
		const assertion = expect(stalled).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(CLAUDE_COMMAND_TIMEOUT_MS);
		await assertion;
		expect(fake.kill).toHaveBeenCalledWith(9);

		vi.useRealTimers();
		fake.hangOn = null;
		await expect(setClaudeModEnabled("prismantis", true)).resolves.toMatchObject({ current: true });
	});

	it("surfaces the CLI's error and lets the next change run", async () => {
		fake.failOn[`plugin marketplace add ${PINNED_SOURCE}`] = "network unreachable";
		await expect(setClaudeModEnabled("prismantis", true)).rejects.toThrow("network unreachable");
		await expect(setClaudeModEnabled("prismantis", false)).resolves.toMatchObject({ enabled: false });
	});

	it("refuses to change anything when the CLI is missing", async () => {
		fake.missing = true;
		await expect(setClaudeModEnabled("prismantis", true)).rejects.toThrow("not found");
		expect(fake.log).toEqual(["plugin list --json"]);
	});
});
