import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Tripwire for the trap that caused the original bug: `DEV3_HOME` names BOTH a
 * derived constant and an environment variable. While the constant ignored the
 * variable, three modules honoured the variable and the app did not, so a
 * redirected instance was half-scoped — and every individual file looked right.
 *
 * They agree now, because the constant is built from the variable. This test keeps
 * them that way by failing when a module composes the data root from a user home
 * itself instead of going through `resolveDev3Home`.
 */

// `import.meta.dir` is a Bun value and is undefined under vitest.
const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every entry is a deliberate exception with a reason. A new file cannot be added
 * casually — the point is that composing the root yourself becomes a decision
 * someone has to argue for.
 */
const ALLOWED: Record<string, string> = {
	"paths.ts": "the single source itself",
	"rate-limit-monitor.ts": "locates the INSTALLED dev3 CLI binary, which lives in the real home even when the data root is redirected",
	"tmux/binary.ts": "same: the real ~/.dev3.0/bin/tmux shim, not board state",
	"index.ts": "appends the real ~/.dev3.0/bin to the user's shell rc — about the installed CLI, not this instance's data",
	"agents.ts": "grants an agent CLI access to the real worktrees/sockets; scoping those is the follow-up task",
	"codex-config.ts": "same as agents.ts — writes real paths into the user's own ~/.codex/config.toml",
	"agent-skills.ts": "skill TEXT shown to agents, plus the real sockets path in ~/.claude/settings.json",
	"conversation-search.ts": "reads historical transcripts, which exist only under the real home",
};

function composesDev3HomeItself(source: string): boolean {
	// A literal `.dev3.0` on the same line as something home-shaped, in code rather
	// than in a comment or a template shown to the user.
	return source
		.split("\n")
		.filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
		.some((line) => /\.dev3\.0/.test(line) && /home|HOME|USERPROFILE/i.test(line));
}

describe("the dev3 data root has one source", () => {
	it("no app module composes ~/.dev3.0 outside the allowlist", () => {
		const offenders: string[] = [];
		for (const entry of readdirSync(APP_ROOT, { recursive: true, encoding: "utf-8" })) {
			const rel = entry.replaceAll("\\", "/");
			if (!rel.endsWith(".ts")) continue;
			if (rel.includes("__tests__/")) continue;
			// Generated, not authored: bundled changelog prose quotes user-facing paths.
			if (rel.endsWith(".generated.ts") || rel === "changelog-bundled.ts") continue;
			if (rel in ALLOWED) continue;
			if (composesDev3HomeItself(readFileSync(join(APP_ROOT, rel), "utf-8"))) offenders.push(rel);
		}
		expect(offenders, "compose the data root via resolveDev3Home(), or add a reasoned allowlist entry").toEqual([]);
	});

	it("all three modules that started the bug no longer compose it themselves", () => {
		// The exact three non-test places that honoured env.DEV3_HOME with their own
		// inline fallback chain while the app's own DEV3_HOME ignored it.
		for (const file of [
			"native-terminal-registry/paths.ts",
			"native-terminal-multipane/paths.ts",
			"prototypes/detached-pty/state.ts",
		]) {
			const source = readFileSync(join(APP_ROOT, file), "utf-8");
			expect(composesDev3HomeItself(source), `${file} must use resolveDev3Home`).toBe(false);
			expect(source).toContain("resolveDev3Home");
		}
	});

	it("the CLI resolves the same root, because it is a separate process", () => {
		// Without this the isolation is half: a scoped app instance plus a dev3 CLI
		// still pointed at the user's real board.
		for (const file of ["context.ts", "spaces.ts", "commands/install-hooks.ts"]) {
			const source = readFileSync(join(APP_ROOT, "..", "cli", file), "utf-8");
			expect(source, `src/cli/${file} must use resolveDev3Home`).toContain("resolveDev3Home");
		}
	});
});
