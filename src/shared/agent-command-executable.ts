/**
 * Which program an agent base command makes the launch shell exec — what an
 * "is it installed" check has to look for. A base command is either one absolute
 * path or shell text that may carry a wrapper, env assignments and arguments
 * (`env /opt/bin/opencode mini`, `FOO=1 npx claude`).
 *
 * Why three answers and not two: `decisions/2026/11/08/agent-binary-check-reads-the-executable-token.md`.
 */
import { isAbsoluteCommandPath, launchDialectId } from "./platform-launch";

export type CommandExecutable =
	/** Exec'd as exactly this path. */
	| { kind: "path"; path: string }
	/** Resolved through PATH. */
	| { kind: "name"; name: string }
	/** Only the shell can tell (an expansion, a builtin, a relative path): not checkable up front. */
	| { kind: "unknown" };

const UNKNOWN: CommandExecutable = { kind: "unknown" };

interface ShellWord {
	text: string;
	/** The shell would expand or interpret part of it, so `text` is not what runs. */
	dynamic: boolean;
}

const POSIX_SYNTAX = new Set("$`*?[](){}<>|&;");
const POWERSHELL_SYNTAX = new Set("$`(){}<>|&;@");
/** What a backslash still escapes inside POSIX double quotes. */
const POSIX_DOUBLE_QUOTE_ESCAPABLE = new Set('$`"\\');

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Bash builtins and keywords: they run with no file on PATH, or run something else entirely. */
const SHELL_BUILTINS = new Set([
	"exec", "command", "builtin", "eval", "source", ".", "time", "cd", "export", "set", "unset",
	"if", "for", "while", "until", "case", "!",
]);

/** Split shell text into words, quotes resolved. Null when a quote never closes. */
function shellWords(command: string, windows: boolean): ShellWord[] | null {
	const syntax = windows ? POWERSHELL_SYNTAX : POSIX_SYNTAX;
	const words: ShellWord[] = [];
	let text = "";
	let dynamic = false;
	// Separate from `text`: `''` is a word too.
	let open = false;
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		const next = command[i + 1];
		if (quote === "'") {
			if (ch === "'") quote = null;
			else text += ch;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') {
				quote = null;
			} else if (next !== undefined && (windows ? ch === "`" : ch === "\\" && POSIX_DOUBLE_QUOTE_ESCAPABLE.has(next))) {
				text += next;
				i++;
			} else {
				if (ch === "$" || ch === "`") dynamic = true;
				text += ch;
			}
			continue;
		}
		if (/\s/.test(ch)) {
			if (open) words.push({ text, dynamic });
			text = "";
			dynamic = false;
			open = false;
			continue;
		}
		open = true;
		if (ch === "'" || ch === '"') {
			quote = ch;
		} else if (!windows && ch === "\\" && next !== undefined) {
			text += next;
			i++;
		} else {
			if (syntax.has(ch) || (text === "" && (ch === "~" || ch === "#"))) dynamic = true;
			text += ch;
		}
	}
	if (quote) return null;
	if (open) words.push({ text, dynamic });
	return words;
}

/** Index of the first word after `env`'s own options, or -1 when one of them is not understood. */
function afterEnvOptions(words: ShellWord[], start: number): number {
	let i = start;
	while (i < words.length && words[i]!.text.startsWith("-")) {
		const { text, dynamic } = words[i]!;
		if (dynamic) return -1;
		if (text === "--") return i + 1;
		if (text === "-" || text === "-i" || text === "--ignore-environment") i += 1;
		else if (text === "-u" || text === "--unset") i += 2;
		else if (text.startsWith("--unset=") || /^-u./.test(text)) i += 1;
		else return -1;
	}
	return i;
}

function afterAssignments(words: ShellWord[], start: number): number {
	let i = start;
	while (i < words.length && ASSIGNMENT.test(words[i]!.text)) i++;
	return i;
}

export function agentCommandExecutable(baseCommand: string, platform: NodeJS.Platform = process.platform): CommandExecutable {
	if (isAbsoluteCommandPath(baseCommand, platform)) return { kind: "path", path: baseCommand };
	const windows = launchDialectId(platform) === "windows-powershell";
	const words = shellWords(baseCommand, windows);
	if (!words) return UNKNOWN;

	let i = 0;
	// PowerShell has neither `VAR=value cmd` nor `env`.
	if (!windows) {
		i = afterAssignments(words, i);
		if (words[i]?.text === "env" && !words[i]!.dynamic) {
			i = afterEnvOptions(words, i + 1);
			if (i < 0) return UNKNOWN;
			i = afterAssignments(words, i);
		}
	}

	const word = words[i];
	if (!word || word.dynamic || (!windows && SHELL_BUILTINS.has(word.text))) return UNKNOWN;
	if (isAbsoluteCommandPath(word.text, platform)) return { kind: "path", path: word.text };
	// A relative path resolves against the pane's cwd — a worktree that may not exist yet.
	const relativePath = windows ? /[\\/]/.test(word.text) : word.text.includes("/");
	return relativePath ? UNKNOWN : { kind: "name", name: word.text };
}
