/**
 * The Codex execpolicy file dev3 owns (`<CODEX_HOME>/rules/dev3.rules`). It makes
 * Codex ask the user before any dev3 subcommand outside the Claude allowlist
 * (`DEV3_AUTO_APPROVED_SUBCOMMANDS`), so `dev3 pane run "<cmd>"` is no longer a
 * silent way out of the sandbox. Issue #2043; the limits are in
 * `decisions/2026/11/15/codex-dev3-execpolicy-rules.md`.
 */
import { DEV3_AUTO_APPROVED_SUBCOMMANDS } from "./agent-hooks";

/** One top-level CLI command and the subcommands it accepts. */
export interface CliCommandSpec {
	name: string;
	subcommands: string[];
}

export const CODEX_DEV3_RULES_FILE = "dev3.rules";

export const CODEX_DEV3_RULES_HEADER =
	"# Managed by dev3 and rewritten on every start. Put your own rules in another file.";

/** Global flags main.ts accepts before or between command words. */
const POSITION_INDEPENDENT_FLAGS = ["--instance"];

const JUSTIFICATION = "This dev3 command can start a process outside the sandbox, so it needs the user's approval.";

/**
 * Every argv prefix that must prompt: whole commands with nothing allowlisted,
 * and the unlisted subcommands of a command that is only partly allowlisted.
 * Codex applies the strictest matching rule, so an allow rule could never carve
 * an exception out of a broad prompt; the prompt set is the allowlist's complement.
 */
export function dev3PromptPrefixes(commands: CliCommandSpec[], allowlist: readonly string[] = DEV3_AUTO_APPROVED_SUBCOMMANDS): string[][] {
	const whole = new Set(allowlist.filter((entry) => !entry.includes(" ")));
	const partial = new Map<string, Set<string>>();
	for (const entry of allowlist) {
		const [parent, sub] = entry.split(" ");
		if (sub === undefined) continue;
		if (!partial.has(parent)) partial.set(parent, new Set());
		partial.get(parent)?.add(sub);
	}

	const prefixes: string[][] = POSITION_INDEPENDENT_FLAGS.map((flag) => [flag]);
	for (const command of commands) {
		if (whole.has(command.name)) continue;
		const allowed = partial.get(command.name);
		if (!allowed) {
			prefixes.push([command.name]);
			continue;
		}
		for (const sub of command.subcommands) {
			if (!allowed.has(sub)) prefixes.push([command.name, sub]);
		}
		for (const flag of POSITION_INDEPENDENT_FLAGS) prefixes.push([command.name, flag]);
	}
	return prefixes;
}

function starlarkString(value: string): string {
	return JSON.stringify(value);
}

function starlarkToken(alternatives: string[]): string {
	return alternatives.length === 1 ? starlarkString(alternatives[0]) : `[${alternatives.map(starlarkString).join(", ")}]`;
}

/**
 * The rules file text. `cliSpellings` are the program names an agent may type
 * (`dev3`, `~/.dev3.0/bin/dev3`, the expanded path); each becomes one alternative
 * of the first pattern token.
 */
export function buildCodexDev3Rules(commands: CliCommandSpec[], cliSpellings: string[]): string {
	const program = starlarkToken([...new Set(cliSpellings)]);
	const lines = [CODEX_DEV3_RULES_HEADER, ""];
	for (const prefix of dev3PromptPrefixes(commands)) {
		const pattern = [program, ...prefix.map(starlarkString)].join(", ");
		lines.push(`prefix_rule(pattern=[${pattern}], decision="prompt", justification=${starlarkString(JUSTIFICATION)})`);
	}
	return `${lines.join("\n")}\n`;
}
