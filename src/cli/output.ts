import {
	CLI_EXIT_CODE_APP_NOT_RUNNING,
	CLI_EXIT_CODE_COMMAND_FAILED,
	CLI_EXIT_CODE_INTERNAL_ERROR,
	CLI_EXIT_CODE_SUCCESS,
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

export function exitAppNotRunning(
	opts: {
		stage?: "discovery" | "connect" | "endpoint";
		diagnostics?: string;
		socketPath?: string;
		/** Why the endpoint record is unusable (Windows loopback transport only). */
		reason?: string;
		/**
		 * `--tolerate-app-offline`: report the same notice on stderr but exit 0.
		 * Generated agent hooks use it where no POSIX shell is available to
		 * collapse exit code 2 themselves (see `TOLERATE_APP_OFFLINE_FLAG`).
		 */
		tolerate?: boolean;
	} = {},
): never {
	let message: string;
	let detail: string;

	if (opts.stage === "endpoint") {
		// Windows loopback transport only: the endpoint record we dialed does not
		// describe a live dev3 instance any more (corrupt/foreign record, or the
		// listener rejected its token because the port was taken over). Retrying
		// is the right advice — the app rewrites the record on every start.
		message = "cannot reach the dev3.0 app";
		const where = opts.socketPath ? ` (${opts.socketPath})` : "";
		detail =
			`A dev3.0 endpoint record was found${where}, but it no longer points at a live app instance.\n` +
			(opts.reason ? `Reason: ${opts.reason}.\n` : "") +
			"This is normal right after the app exits or restarts — retry the command.\n" +
			"If it persists, quit dev-3.0 completely and start it again; the app rewrites its\n" +
			"endpoint record on every launch.";
	} else if (opts.stage === "connect") {
		// A socket file was found but the live connection failed. Two causes:
		// the calling agent's sandbox (Claude Code seatbelt / Codex) blocking the
		// Unix-socket connect (issue #726), or the socket belonging to an app
		// instance that just exited — e.g. a dev-channel dev3 build that was
		// hosted inside a dev-server session being stopped (#910/#920). Say both
		// instead of "start the app".
		message = "cannot reach the dev3.0 app";
		const where = opts.socketPath ? ` (${opts.socketPath})` : "";
		detail =
			`A dev3.0 socket was found${where}, but the live connection was refused or blocked.\n` +
			"If the selected instance just exited (e.g. a dev build hosted in a dev-server\n" +
			"session you stopped), its socket may be stale — simply retry the command.\n" +
			"Otherwise the app is likely running and your agent's sandbox may be blocking the Unix socket:\n" +
			"  • Claude Code: add the dev3 sockets dir to sandbox.network.allowUnixSockets in\n" +
			"    ~/.claude/settings.json, then fully restart Claude Code (resume does not reapply it).\n" +
			"  • Codex (>= 0.119): under [permissions.<profile>.network.unix_sockets] set the\n" +
			'    dev3 sockets dir = "allow".\n' +
			"dev3 patches both automatically on app startup — restarting the desktop app re-applies them.";
	} else {
		message = "app not running";
		detail = "The dev3.0 desktop app must be running to use the CLI.\nStart the app and try again.";
	}

	// Under DEV3_DEBUG, append why resolution failed so bug reports are
	// actionable: "no live socket" (discovery — often a wrong HOME) vs "socket
	// found but connection refused/blocked" (connect — busy app / sandbox denial).
	if (opts.diagnostics) {
		detail += "\n\n[DEV3_DEBUG] app-not-running diagnostics:";
		if (opts.stage === "discovery") {
			detail += "\n  stage: discovery — no live socket found in the sockets dir";
		} else if (opts.stage === "connect") {
			detail += "\n  stage: connect — a socket was found but the connection was refused/blocked";
		} else if (opts.stage === "endpoint") {
			detail += "\n  stage: endpoint — a loopback endpoint record was found but it is stale or unusable";
		}
		detail += `\n${opts.diagnostics}`;
	}

	if (opts.tolerate) {
		process.stderr.write(`warning: ${message}\n`);
		for (const line of detail.split("\n")) process.stderr.write(`  ${line}\n`);
		process.exit(CLI_EXIT_CODE_SUCCESS);
	}

	exitError(message, detail, CLI_EXIT_CODE_APP_NOT_RUNNING);
}

export function exitUsage(message: string): never {
	exitError(message, undefined, CLI_EXIT_CODE_USAGE_ERROR);
}

export function exitInternalError(message: string): never {
	exitError(message, undefined, CLI_EXIT_CODE_INTERNAL_ERROR);
}
