/**
 * Print a table with column headers and rows.
 * Auto-sizes columns based on content width.
 */
export function printTable(headers: string[], rows: string[][]): void {
	const widths = headers.map((h, i) => {
		const colValues = rows.map((r) => (r[i] || "").length);
		return Math.max(h.length, ...colValues);
	});

	const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join("  ");
	process.stdout.write(headerLine + "\n");

	for (const row of rows) {
		const line = row.map((cell, i) => (cell || "").padEnd(widths[i])).join("  ");
		process.stdout.write(line + "\n");
	}
}

/**
 * Print key-value pairs in a vertical layout.
 */
export function printDetail(fields: Array<[string, string]>): void {
	const maxKeyLen = Math.max(...fields.map(([k]) => k.length));
	for (const [key, value] of fields) {
		process.stdout.write(`${key.padEnd(maxKeyLen)}  ${value}\n`);
	}
}

export function exitError(message: string, detail?: string, code = 1): never {
	process.stderr.write(`error: ${message}\n`);
	if (detail) {
		for (const line of detail.split("\n")) {
			process.stderr.write(`  ${line}\n`);
		}
	}
	process.exit(code);
}

export function exitAppNotRunning(): never {
	exitError(
		"app not running",
		"The dev3.0 desktop app must be running to use the CLI.\nStart the app and try again.",
		2,
	);
}

export function exitUsage(message: string): never {
	exitError(message, undefined, 3);
}
