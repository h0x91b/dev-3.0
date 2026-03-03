import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ParsedArgs {
	flags: Record<string, string>;
	positional: string[];
}

export function parseArgs(args: string[]): ParsedArgs {
	const flags: Record<string, string> = {};
	const positional: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--")) {
			const eqIdx = arg.indexOf("=");
			if (eqIdx !== -1) {
				flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
			} else {
				const key = arg.slice(2);
				const next = args[i + 1];
				if (next !== undefined && !next.startsWith("--")) {
					flags[key] = next;
					i++;
				} else {
					flags[key] = "true";
				}
			}
		} else {
			positional.push(arg);
		}
	}

	return { flags, positional };
}

/**
 * Resolve @file references in flag values and positional args.
 * - Values starting with "@" are treated as file paths; the file content replaces the value.
 * - "@@" at the start is an escape: "@@foo" becomes literal "@foo".
 * - Boolean flags (value === "true") are never resolved.
 * - Throws with a descriptive message if a referenced file cannot be read.
 */
export function resolveFileArgs(args: ParsedArgs): ParsedArgs {
	return {
		flags: Object.fromEntries(
			Object.entries(args.flags).map(([key, value]) => [key, resolveValue(value)]),
		),
		positional: args.positional.map(resolveValue),
	};
}

function resolveValue(value: string): string {
	if (value === "true") return value;
	if (value.startsWith("@@")) return value.slice(1);
	if (!value.startsWith("@")) return value;

	const filePath = resolve(value.slice(1));
	try {
		return readFileSync(filePath, "utf-8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new Error(`File not found: ${filePath} (from "${value}")`);
		}
		if (code === "EISDIR") {
			throw new Error(`Path is a directory, not a file: ${filePath} (from "${value}")`);
		}
		throw new Error(`Cannot read file ${filePath}: ${(err as Error).message}`);
	}
}
