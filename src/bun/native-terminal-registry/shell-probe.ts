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

export function powershellArgvProbeCommand(executable: string, probePath: string, args: string[]): string {
	assertSingleLineArgs([executable, probePath, ...args]);
	const argumentLine = [probePath, ...args].map(windowsArg).join(" ");
	return `$probe = Start-Process -FilePath ${powershellLiteral(executable)} -ArgumentList ${powershellLiteral(argumentLine)} -NoNewWindow -Wait -PassThru; if ($probe.ExitCode -ne 0) { throw "argv probe exited $($probe.ExitCode)" }`;
}

function cmdBatchArg(value: string): string {
	return `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`;
}

export function cmdArgvProbeBatch(args: string[]): string {
	assertSingleLineArgs(args);
	const quotedArgs = args.map(cmdBatchArg).join(" ");
	return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%DEV3_BUN_EXE%" "%DEV3_ARG_PROBE%" ${quotedArgs}\r\nendlocal\r\n`;
}
