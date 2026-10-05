import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
	CLI_EXIT_CODE_ARTIFACT_ASSET_MISSING,
	CLI_EXIT_CODE_ARTIFACT_SECRET_FOUND,
	CLI_EXIT_CODE_SUCCESS,
} from "../../shared/cli-exit-codes";
import { inlineHtmlSource, type InlineState } from "../../shared/html-inline";
import { resolveValue } from "../args";
import { exitUsage } from "../output";

/** Credentials must never reach a public URL. Everything else is a soft warning. */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
	["github token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g],
	["github pat", /\bgithub_pat_[A-Za-z0-9_]{20,}/g],
	["openai/anthropic key", /\bsk-[A-Za-z0-9-]{20,}/g],
	["aws key id", /\bAKIA[0-9A-Z]{16}\b/g],
	["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
];

const LEAK_PATTERNS: Array<[string, RegExp]> = [
	["home path", /\/(?:Users|home)\/[A-Za-z0-9._-]+/g],
	["windows user path", /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g],
	["email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
	["tunnel url", /https?:\/\/[A-Za-z0-9.-]+\.(?:trycloudflare\.com|ngrok[a-z.-]*|loca\.lt)\b/g],
];

const MAX_REPORTED_LEAKS = 25;

export interface InlineReport extends InlineState {
	input: string;
	output: string;
	bytes: number;
	secrets: Array<{ kind: string; sample: string }>;
	possibleLeaks: Array<{ kind: string; value: string }>;
	error?: string;
}

/** Fold every local stylesheet, script, image and font into one HTML string. */
export function inlineHtml(htmlPath: string): { html: string; state: InlineState } {
	const read = (path: string) => (existsSync(path) && statSync(path).isFile() ? readFileSync(path) : null);
	return inlineHtmlSource(readFileSync(htmlPath, "utf-8"), dirname(htmlPath), read);
}

/** Credential hits block publishing; leak hits are reported and deduped. */
export function scanForSecrets(text: string): {
	secrets: Array<{ kind: string; sample: string }>;
	possibleLeaks: Array<{ kind: string; value: string }>;
} {
	const secrets: Array<{ kind: string; sample: string }> = [];
	for (const [kind, pattern] of SECRET_PATTERNS) {
		for (const match of text.matchAll(pattern)) {
			secrets.push({ kind, sample: `${match[0].slice(0, 12)}…` });
		}
	}

	const seen = new Set<string>();
	const possibleLeaks: Array<{ kind: string; value: string }> = [];
	for (const [kind, pattern] of LEAK_PATTERNS) {
		for (const match of text.matchAll(pattern)) {
			if (seen.has(match[0])) continue;
			seen.add(match[0]);
			possibleLeaks.push({ kind, value: match[0] });
		}
	}

	return { secrets, possibleLeaks: possibleLeaks.slice(0, MAX_REPORTED_LEAKS) };
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}

/**
 * `dev3 inline-html <index.html|dir> -o out.html [--json] [--quiet]`.
 *
 * Needs no socket: it is a pure file transform an agent runs before publishing a
 * report (gists and preview services serve one text file at a time).
 */
export async function handleInlineHtml(argv: string[]): Promise<void> {
	let input = "";
	let output = "";
	let json = false;
	let quiet = false;

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--json") {
			json = true;
			continue;
		}
		if (token === "--quiet") {
			quiet = true;
			continue;
		}
		if (token === "-o" || token === "--output") {
			const next = argv[i + 1];
			if (!next || next.startsWith("--")) exitUsage("-o/--output requires a value");
			output = resolveValue(next);
			i += 1;
			continue;
		}
		if (token.startsWith("--output=")) {
			output = resolveValue(token.slice("--output=".length));
			continue;
		}
		if (token.startsWith("-")) exitUsage(`Unknown flag: ${token}`);
		if (input) exitUsage(`Unexpected path: ${token}. One input only.`);
		input = resolveValue(token);
	}

	if (!input || !output) {
		exitUsage("Usage: dev3 inline-html <index.html|dir> -o <out.html> [--json] [--quiet]");
	}

	let source = resolvePath(process.cwd(), expandHome(input));
	if (existsSync(source) && statSync(source).isDirectory()) source = join(source, "index.html");
	if (!existsSync(source) || !statSync(source).isFile()) exitUsage(`No such file: ${source}`);

	const target = resolvePath(process.cwd(), expandHome(output));
	const { html, state } = inlineHtml(source);
	const { secrets, possibleLeaks } = scanForSecrets(html);

	const report: InlineReport = {
		input: source,
		output: target,
		bytes: Buffer.byteLength(html, "utf-8"),
		inlined: state.inlined,
		external: state.external,
		missing: state.missing,
		secrets,
		possibleLeaks,
	};

	// Both refusals print the full report so the agent can name the cause without
	// a second run, and neither writes the file.
	if (state.missing.length > 0) {
		report.error = "missing local files — the page would render broken";
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		process.exit(CLI_EXIT_CODE_ARTIFACT_ASSET_MISSING);
	}
	if (secrets.length > 0) {
		report.error = "credential-looking string found — do not publish";
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		process.exit(CLI_EXIT_CODE_ARTIFACT_SECRET_FOUND);
	}

	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, html, "utf-8");

	if (json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	} else if (!quiet) {
		process.stdout.write(`wrote ${target} (${report.bytes.toLocaleString("en-US")} bytes)\n`);
		process.stdout.write(`  inlined:  ${state.inlined.length}\n`);
		process.stdout.write(`  external: ${state.external.length} (left as-is)\n`);
		for (const ref of state.external) process.stdout.write(`    - ${ref.ref}\n`);
		// Say "clean" out loud: silence would read as "the scan never ran".
		process.stdout.write("  secrets:  none found\n");
		if (possibleLeaks.length > 0) {
			process.stdout.write(`  possible leaks: ${possibleLeaks.length} — review before making it public\n`);
			for (const leak of possibleLeaks.slice(0, 10)) {
				process.stdout.write(`    - ${leak.kind}: ${leak.value}\n`);
			}
		} else {
			process.stdout.write("  possible leaks: none found (no home paths, emails or tunnel URLs)\n");
		}
	}

	process.exit(CLI_EXIT_CODE_SUCCESS);
}
