import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-toml";
import {
	backupUnparsableCodexConfig,
	ensureCodexConfig,
	ensureCodexConfigFile,
	repairWindowsPathEscapes,
	tomlBasicString,
} from "../codex-config";

const WIN_WORKTREES = "C:\\Users\\user\\.dev3.0\\worktrees";
const WIN_SOCKETS = "C:\\Users\\user\\.dev3.0\\sockets";

/**
 * The whole point of this file is that it also runs on windows-latest. Asserting
 * on the string we wrote is what let the unparsable config ship, so every check
 * here decodes the output with a real TOML parser instead.
 */
describe("codex config with Windows paths", () => {
	it("produces a config a real TOML parser accepts", () => {
		const out = ensureCodexConfig(null, WIN_WORKTREES, WIN_SOCKETS, [
			"C:\\Users\\user\\.dev3.0\\worktrees\\proj\\abcd1234\\worktree",
		]);

		const parsed = load(out) as Record<string, any>;
		expect(Object.keys(parsed.projects)).toContain(WIN_WORKTREES);
		expect(Object.keys(parsed.projects)).toContain(
			"C:\\Users\\user\\.dev3.0\\worktrees\\proj\\abcd1234\\worktree",
		);
		expect(parsed.projects[WIN_WORKTREES].trust_level).toBe("trusted");
	});

	it("round-trips the socket path through both socket syntaxes", () => {
		const legacy = load(
			ensureCodexConfig(null, WIN_WORKTREES, WIN_SOCKETS, [], { codexVersion: "0.118.0" }),
		) as Record<string, any>;
		expect(legacy.permissions.dev3.network.allow_unix_sockets).toEqual([WIN_SOCKETS]);

		const modern = load(
			ensureCodexConfig(null, WIN_WORKTREES, WIN_SOCKETS, [], { codexVersion: "0.131.0" }),
		) as Record<string, any>;
		expect(modern.permissions.dev3.network.unix_sockets[WIN_SOCKETS]).toBe("allow");
	});

	it("stays idempotent — a second pass adds no duplicate project entry", () => {
		const first = ensureCodexConfig(null, WIN_WORKTREES, WIN_SOCKETS, []);
		const second = ensureCodexConfig(first, WIN_WORKTREES, WIN_SOCKETS, []);
		expect(second).toBe(first);
		expect(() => load(second)).not.toThrow();
	});

	it("escapes nothing in a POSIX path — byte-identical output", () => {
		expect(tomlBasicString("/Users/x/.dev3.0/worktrees")).toBe('"/Users/x/.dev3.0/worktrees"');
		const out = ensureCodexConfig(null, "/Users/x/.dev3.0/worktrees", "/Users/x/.dev3.0/sockets", []);
		expect(out).toContain('[projects."/Users/x/.dev3.0/worktrees"]');
		expect(out).toContain('"/Users/x/.codex/skills" = "read"');
		expect(out).toContain('"/Users/x/.dev3.0" = "write"');
		expect(out).not.toContain("\\\\");
	});
});

const BROKEN_CONFIG = [
	"# my own notes, do not touch",
	'model = "gpt-5"',
	"",
	"[projects.\"C:\\Users\\user/.dev3.0/worktrees\"]",
	'trust_level = "trusted"',
	"",
	"[permissions.dev3.filesystem]",
	'":minimal" = "read"',
	'"C:\\Users\\user\\.codex\\skills" = "read"',
	'"C:\\Users\\user\\.dev3.0" = "write"',
	"",
	"[my_own_section]",
	'note = "kept verbatim"',
	"",
].join("\n");

describe("repairing an already-broken config", () => {
	it("the fixture really is unparsable (guard for the repair test)", () => {
		expect(() => load(BROKEN_CONFIG)).toThrow();
	});

	it("repairs dev3's own entries and leaves everything else byte-identical", () => {
		const repaired = repairWindowsPathEscapes(BROKEN_CONFIG);
		expect(repaired).not.toBeNull();

		const parsed = load(repaired as string) as Record<string, any>;
		expect(parsed.model).toBe("gpt-5");
		expect(parsed.my_own_section.note).toBe("kept verbatim");
		expect(Object.keys(parsed.projects)[0]).toBe("C:\\Users\\user/.dev3.0/worktrees");
		expect(parsed.permissions.dev3.filesystem["C:\\Users\\user\\.codex\\skills"]).toBe("read");

		expect(repaired).toContain("# my own notes, do not touch");
		expect(repaired).toContain("[my_own_section]");
		expect((repaired as string).split("\n").length).toBe(BROKEN_CONFIG.split("\n").length);
	});

	it("patches a broken config instead of giving up on it", () => {
		const out = ensureCodexConfig(BROKEN_CONFIG, WIN_WORKTREES, WIN_SOCKETS, []);
		const parsed = load(out) as Record<string, any>;
		expect(parsed.model).toBe("gpt-5");
		expect(parsed.my_own_section.note).toBe("kept verbatim");
		expect(parsed.features.hooks ?? parsed.features.codex_hooks).toBe(true);
	});

	it("leaves a file broken for any other reason completely alone", () => {
		const notOurBug = 'model = "gpt-5"\n[unclosed\n';
		expect(repairWindowsPathEscapes(notOurBug)).toBeNull();
		expect(ensureCodexConfig(notOurBug, WIN_WORKTREES, WIN_SOCKETS, [])).toBe(notOurBug);
	});

	it("never rewrites a user's own Windows path outside dev3's shapes", () => {
		const userLine = 'my_tool_path = "C:\\Users\\user\\tools"';
		expect(repairWindowsPathEscapes(userLine)).toBeNull();
	});

	it("backs the broken file up once, and not at all when it parses", () => {
		const dir = mkdtempSync(join(tmpdir(), "dev3-codex-backup-"));
		const configPath = join(dir, "config.toml");

		writeFileSync(configPath, BROKEN_CONFIG, "utf-8");
		backupUnparsableCodexConfig(configPath, BROKEN_CONFIG);
		expect(readFileSync(`${configPath}.dev3-backup`, "utf-8")).toBe(BROKEN_CONFIG);

		const goodPath = join(dir, "good.toml");
		writeFileSync(goodPath, 'model = "gpt-5"\n', "utf-8");
		backupUnparsableCodexConfig(goodPath, 'model = "gpt-5"\n');
		expect(existsSync(`${goodPath}.dev3-backup`)).toBe(false);
	});
});

describe("ensureCodexConfigFile against a real home directory", () => {
	it("writes a parsable config and repairs a broken one in place", () => {
		const home = mkdtempSync(join(tmpdir(), "dev3-codex-home-"));
		mkdirSync(join(home, ".codex"), { recursive: true });
		const configPath = join(home, ".codex", "config.toml");

		ensureCodexConfigFile(home);
		const fresh = readFileSync(configPath, "utf-8");
		const parsed = load(fresh) as Record<string, any>;
		expect(Object.keys(parsed.projects)).toContain(join(home, ".dev3.0", "worktrees"));

		writeFileSync(configPath, BROKEN_CONFIG, "utf-8");
		ensureCodexConfigFile(home);
		const healed = readFileSync(configPath, "utf-8");
		const healedParsed = load(healed) as Record<string, any>;
		expect(healedParsed.model).toBe("gpt-5");
		expect(healedParsed.my_own_section.note).toBe("kept verbatim");
		expect(readFileSync(`${configPath}.dev3-backup`, "utf-8")).toBe(BROKEN_CONFIG);
	});
});
