import { describe, it, expect } from "vitest";
import { load } from "js-toml";
import { ensureCodexConfig, isDev3TrustPath, pruneCodexProjectEntries } from "../codex-config";

const HOME = "/Users/testuser";
const DEV3_HOME = `${HOME}/.dev3.0`;
const WORKTREES_PATH = `${DEV3_HOME}/worktrees`;
const SOCKETS_PATH = `${DEV3_HOME}/sockets`;

const trustBlock = (path: string) => `[projects."${path}"]\ntrust_level = "trusted"\n`;

describe("pruneCodexProjectEntries", () => {
	it("removes the selected block and leaves the rest byte-identical", () => {
		const config = `# my own notes
model = "gpt-5.4"

${trustBlock(`${HOME}/my-project`)}
${trustBlock(`${WORKTREES_PATH}/proj/aaaa/worktree`)}
${trustBlock(`${HOME}/other-project`)}`;

		const result = pruneCodexProjectEntries(config, (p) => p.startsWith(WORKTREES_PATH));

		expect(result).not.toContain(WORKTREES_PATH);
		expect(result).toContain("# my own notes");
		expect(result).toContain('[projects."/Users/testuser/my-project"]');
		expect(result).toContain('[projects."/Users/testuser/other-project"]');
		expect(result.indexOf("my-project")).toBeLessThan(result.indexOf("other-project"));
	});

	it("removes sub-tables of the pruned project too", () => {
		const path = `${WORKTREES_PATH}/proj/aaaa/worktree`;
		const config = `${trustBlock(path)}
[projects."${path}".experimental]
foo = 1

${trustBlock(`${HOME}/keep`)}`;

		const result = pruneCodexProjectEntries(config, (p) => p === path);

		expect(result).not.toContain("experimental");
		expect(result).toContain('[projects."/Users/testuser/keep"]');
	});

	it("matches a Windows path written as an escaped basic string", () => {
		const path = "C:\\Users\\test\\.dev3.0\\worktrees\\proj\\aaaa\\worktree";
		const config = `[projects."C:\\\\Users\\\\test\\\\.dev3.0\\\\worktrees\\\\proj\\\\aaaa\\\\worktree"]
trust_level = "trusted"

[projects."C:\\\\Users\\\\test\\\\code"]
trust_level = "trusted"
`;
		expect(Object.keys((load(config) as { projects: Record<string, unknown> }).projects)).toContain(path);

		const result = pruneCodexProjectEntries(config, (p) => p === path);

		expect(result).not.toContain("worktrees");
		expect(result).toContain("code");
	});

	it("matches a path written as a literal string and a path with spaces", () => {
		const literal = "C:\\Users\\test\\dev3 stuff";
		const spaced = `${HOME}/My Projects/app one`;
		const config = `[projects.'C:\\Users\\test\\dev3 stuff']
trust_level = "trusted"

${trustBlock(spaced)}
${trustBlock(`${HOME}/keep`)}`;

		const result = pruneCodexProjectEntries(config, (p) => p === literal || p === spaced);

		expect(result).not.toContain("dev3 stuff");
		expect(result).not.toContain("My Projects");
		expect(result).toContain("keep");
	});

	it("leaves an unparsable config completely alone", () => {
		const config = `[projects."C:\\Users\\test"]\ntrust_level = "trusted"\n`;

		expect(pruneCodexProjectEntries(config, () => true)).toBe(config);
	});

	it("leaves the file alone when a header-looking line lives inside a string value", () => {
		const config = `notes = """
[projects."${WORKTREES_PATH}/proj/aaaa/worktree"]
still inside the string
"""

${trustBlock(`${HOME}/keep`)}`;

		expect(pruneCodexProjectEntries(config, (p) => p.startsWith(WORKTREES_PATH))).toBe(config);
	});

	it("leaves the file alone when the edit would change an unrelated string value", () => {
		// Blank-line collapsing is safe in TOML syntax but not inside a multi-line
		// string: the result still parses, so only the before/after comparison catches it.
		const config = `${trustBlock(`${WORKTREES_PATH}/proj/aaaa/worktree`)}
[notes]
body = """
first


second
"""
`;

		expect(pruneCodexProjectEntries(config, (p) => p.startsWith(WORKTREES_PATH))).toBe(config);
	});

	it("is a no-op when nothing matches", () => {
		const config = trustBlock(`${HOME}/keep`);

		expect(pruneCodexProjectEntries(config, () => false)).toBe(config);
	});

	it("keeps unrelated sections and their values intact", () => {
		const config = `${trustBlock(`${WORKTREES_PATH}/proj/aaaa/worktree`)}
[permissions.dev3.network]
enabled = true

[[hooks.SessionStart]]
matcher = "*"
`;
		const result = pruneCodexProjectEntries(config, () => true);

		expect(load(result)).toEqual({
			permissions: { dev3: { network: { enabled: true } } },
			hooks: { SessionStart: [{ matcher: "*" }] },
		});
	});

	it("prunes a config holding an integer past 2^53, which js-toml decodes as a BigInt", () => {
		// JSON.stringify throws on a BigInt, so the equality guard used to take the
		// whole prune down with a TypeError instead of just skipping this file.
		const config = `max_bytes = 9223372036854775807\n\n${trustBlock(`${WORKTREES_PATH}/proj/aaaa/worktree`)}`;

		const result = pruneCodexProjectEntries(config, () => true);

		expect(result).toContain("max_bytes = 9223372036854775807");
		expect(result).not.toContain(WORKTREES_PATH);
	});
});

describe("isDev3TrustPath", () => {
	it("accepts worktree and ops paths, rejects the roots themselves and user paths", () => {
		expect(isDev3TrustPath(`${WORKTREES_PATH}/proj/aaaa/worktree`, DEV3_HOME)).toBe(true);
		expect(isDev3TrustPath(`${DEV3_HOME}/ops/something`, DEV3_HOME)).toBe(true);
		expect(isDev3TrustPath(WORKTREES_PATH, DEV3_HOME)).toBe(false);
		expect(isDev3TrustPath(`${HOME}/my-project`, DEV3_HOME)).toBe(false);
		expect(isDev3TrustPath(`${HOME}/.dev3.0-elsewhere/worktrees/x`, DEV3_HOME)).toBe(false);
	});

	it("understands Windows roots", () => {
		const home = "C:\\Users\\test\\.dev3.0";
		expect(isDev3TrustPath(`${home}\\worktrees\\proj\\aaaa`, home)).toBe(true);
		expect(isDev3TrustPath("C:\\Users\\test\\code", home)).toBe(false);
	});
});

describe("ensureCodexConfig", () => {
	it("still trusts a worktree that does not exist yet — pruning is teardown's job", () => {
		const fresh = `${WORKTREES_PATH}/proj/fresh/worktree`;

		const result = ensureCodexConfig("", WORKTREES_PATH, SOCKETS_PATH, [fresh]);

		expect(result).toContain(`[projects."${fresh}"]`);
		expect(result).toContain(`[projects."${WORKTREES_PATH}"]`);
	});
});
