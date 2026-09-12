/**
 * The process on the other end of `tmux pipe-pane` (`dev3 __dev-server-log <path>`).
 *
 * tmux hands a pane's raw output to a shell command's stdin; this reads that and
 * writes the same bytes as plain text. Doing it in our own process rather than
 * `cat >> file` is what gives the log stripped escapes, collapsed progress bars
 * and a size cap — and what keeps the pane untouched: the dev server still owns a
 * real tty, so its colours and interactive keys work exactly as before.
 *
 * It must survive the app: the capture keeps running while dev3 is closed, and
 * needs no socket for the same reason a pane run does not.
 */

import { DevServerLogWriter } from "../../bun/dev-server-log";
import { exitUsage } from "../output";

export async function handleDevServerLogSink(argv: string[]): Promise<void> {
	const path = argv[0];
	if (!path) exitUsage("usage: dev3 __dev-server-log <log-file>");

	const writer = new DevServerLogWriter(path);
	const stop = () => {
		writer.close();
		process.exit(0);
	};
	// tmux closes the pipe by killing this process; flush the held line first so a
	// dev server's last output is not the one line missing from its log.
	process.on("SIGTERM", stop);
	process.on("SIGHUP", stop);

	for await (const chunk of Bun.stdin.stream()) writer.write(chunk);
	writer.close();
}
