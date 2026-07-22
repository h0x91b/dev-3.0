function assertSingleLineArgs(args: string[]): void {
	if (args.some((arg) => /[\0\r\n]/.test(arg))) throw new Error("shell probe arguments must be single-line strings");
}

export function powershellLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function windowsArg(value: string): string {
	let quoted = '"';
	let backslashes = 0;
	for (const char of value) {
		if (char === "\\") {
			backslashes++;
			continue;
		}
		if (char === '"') {
			quoted += "\\".repeat(backslashes * 2 + 1) + '"';
			backslashes = 0;
			continue;
		}
		quoted += "\\".repeat(backslashes) + char;
		backslashes = 0;
	}
	return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

export function powershellArgvProbeCommand(args: string[]): string {
	assertSingleLineArgs(args);
	return `& $env:DEV3_BUN_EXE $env:DEV3_ARG_PROBE ${args.map(powershellLiteral).join(" ")}`;
}

export function cmdArgvProbeBatch(args: string[]): string {
	assertSingleLineArgs(args);
	const quotedArgs = args.map((arg) => windowsArg(arg.replaceAll("%", "%%"))).join(" ");
	return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%DEV3_BUN_EXE%" "%DEV3_ARG_PROBE%" ${quotedArgs}\r\nendlocal\r\n`;
}
