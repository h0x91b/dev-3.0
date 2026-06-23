import {
	CLI_EXIT_CODE_APP_NOT_RUNNING,
	CLI_EXIT_CODE_COMMAND_FAILED,
	CLI_EXIT_CODE_INTERNAL_ERROR,
	CLI_EXIT_CODE_USAGE_ERROR,
} from "../shared/cli-exit-codes";

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

export function exitError(message: string, detail?: string, code = CLI_EXIT_CODE_COMMAND_FAILED): never {
	process.stderr.write(`error: ${message}\n`);
	if (detail) {
		for (const line of detail.split("\n")) {
			process.stderr.write(`  ${line}\n`);
		}
	}
	process.exit(code);
}

export function exitAppNotRunning(opts: { stage?: "discovery" | "connect"; diagnostics?: string } = {}): never {
	let detail = "The dev3.0 desktop app must be running to use the CLI.\nStart the app and try again.";

	// Under DEV3_DEBUG, append why resolution failed so bug reports are
	// actionable: "no live socket" (discovery — often a wrong HOME) vs "socket
	// found but connection refused" (connect — busy app / transient backlog).
	if (opts.diagnostics || opts.stage) {
		detail += "\n\n[DEV3_DEBUG] app-not-running diagnostics:";
		if (opts.stage) {
			detail +=
				opts.stage === "discovery"
					? "\n  stage: discovery — no live socket found in the sockets dir"
					: "\n  stage: connect — a socket was found but the connection was refused";
		}
		if (opts.diagnostics) detail += `\n${opts.diagnostics}`;
	}

	exitError("app not running", detail, CLI_EXIT_CODE_APP_NOT_RUNNING);
}

export function exitUsage(message: string): never {
	exitError(message, undefined, CLI_EXIT_CODE_USAGE_ERROR);
}

export function exitInternalError(message: string): never {
	exitError(message, undefined, CLI_EXIT_CODE_INTERNAL_ERROR);
}
