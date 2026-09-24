import type { ParsedArgs } from "./args";
import { exitUsage } from "./output";

/**
 * The one body of text a command was given: the positional argument or `--<flag>`.
 * Any shape that would drop part of the input — both forms at once, extra unquoted
 * words, or the flag left without a value — is refused instead of guessed at.
 * Returns undefined when neither form was used; "-" is left for the caller to read.
 */
export function singleTextInput(args: ParsedArgs, flag: string): string | undefined {
	const flagged = args.flags[flag];
	if (flagged === "true") {
		exitUsage(`--${flag} needs the text as its value; use --${flag} - to read it from stdin, or --${flag} @file.`);
	}
	if (args.positional.length > 1) {
		exitUsage(
			`Got ${args.positional.length} separate text arguments, and only the first would be kept. ` +
				`Quote the whole text as one argument, or pass it with --${flag} - (stdin) or @file.`,
		);
	}
	const positional = args.positional[0];
	if (positional !== undefined && flagged !== undefined) {
		exitUsage(
			`Text was given twice — as a positional argument and as --${flag} — and one would be silently dropped. ` +
				"Pass it once.",
		);
	}
	return positional ?? flagged;
}
