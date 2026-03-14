import { sendRequest } from "../socket-client";
import { printTable, exitError } from "../output";
import type { ParsedArgs } from "../args";
import type { CliContext } from "../context";

export async function handleConfig(
	subcommand: string | undefined,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	const projectId = args.flags?.project || context?.projectId;
	const worktreePath = context?.worktreePath;

	if (subcommand === "export") {
		if (!projectId) exitError("Could not detect project. Use --project <id> or run from a worktree.");
		const resp = await sendRequest(socketPath, "config.export", { projectId, worktreePath });
		if (!resp.ok) exitError(resp.error || "Failed to export config");
		const result = resp.data as { path: string };
		process.stdout.write(`Exported project settings to ${result.path}\n`);
		return;
	}

	if (subcommand === "show" || !subcommand) {
		if (!projectId) exitError("Could not detect project. Use --project <id> or run from a worktree.");
		const resp = await sendRequest(socketPath, "config.show", { projectId, worktreePath });
		if (!resp.ok) exitError(resp.error || "Failed to get config");

		const result = resp.data as {
			settings: Record<string, unknown>;
			sources: Record<string, string>;
			hasRepoConfig: boolean;
		};

		process.stdout.write(`Repo config (.dev3/config.json): ${result.hasRepoConfig ? "exists" : "not found"}\n\n`);

		printTable(
			["FIELD", "VALUE", "SOURCE"],
			Object.entries(result.settings).map(([field, value]) => {
				const display = Array.isArray(value) ? value.join(", ") || "(empty)" :
					typeof value === "boolean" ? String(value) :
					typeof value === "string" ? (value || "(empty)") :
					String(value ?? "(not set)");
				return [field, display.length > 60 ? display.slice(0, 57) + "..." : display, result.sources[field] || "global"];
			}),
		);
		return;
	}

	exitError(`Unknown subcommand: config ${subcommand}`, "Available: config show, config export", 3);
}
