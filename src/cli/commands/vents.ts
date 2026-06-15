import { sendRequest } from "../socket-client";
import { exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { rejectUnknownFlags } from "../flag-validation";

/**
 * `dev3 vents <name> <markdown>` — file a local, anonymous "vent" about the
 * dev3 platform itself (CLI, skill, tmux, docs). Writes one markdown file under
 * ~/.dev3.0/vents/ for the dev3 maintainer to read. Always available; there is
 * no UI and no opt-in.
 *
 * IMPORTANT (for the calling agent): vents are anonymous. Never include code,
 * project paths, task content, user data, or anything app-specific — only
 * platform friction. dev3 deliberately attaches zero context on its side.
 */
export async function handleVents(args: ParsedArgs, socketPath: string): Promise<void> {
	rejectUnknownFlags(args, ["name", "content"]);

	const name = (args.positional[0] || args.flags.name || "").trim();
	const content = (args.positional[1] || args.flags.content || "").trim();

	if (!name || !content) {
		exitUsage('Usage: dev3 vents "short name" "markdown body" (anonymous dev3-platform feedback; no PII, no project specifics)');
	}

	const resp = await sendRequest(socketPath, "vent.add", { name, content });
	if (!resp.ok) exitError(resp.error || "Failed to record vent");

	const data = resp.data as { fileName?: string };
	process.stdout.write(`Vent recorded: ${data.fileName}\n`);
}
