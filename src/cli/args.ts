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
