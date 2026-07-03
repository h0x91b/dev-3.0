import { sendRequest } from "../socket-client";
import { printTable, exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { resolveProjectId, type CliContext } from "../context";

/**
 * Render a resolved config value for the `dev3 config show` table. Handles every
 * shape a config field can take so nothing prints as an opaque "[object Object]":
 * arrays → comma list, empty → "(empty)", objects → a readable summary (e.g. the
 * builtin column-agent map as a count), null/undefined → "(not set)".
 */
function formatConfigValue(field: string, value: unknown): string {
	if (Array.isArray(value)) return value.join(", ") || "(empty)";
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number") return String(value);
	if (typeof value === "string") return value || "(empty)";
	if (value !== null && typeof value === "object") {
		const keys = Object.keys(value as Record<string, unknown>);
		if (field === "builtinColumnAgents") {
			return keys.length === 1 ? "1 column" : `${keys.length} columns`;
		}
		return JSON.stringify(value);
	}
	return "(not set)";
}

export async function handleConfig(
	subcommand: string | undefined,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	const projectId = resolveProjectId(args.flags?.project, context);
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
				const display = formatConfigValue(field, value);
				// The backend sends a source for every key (local/repo/project/default/
				// unset); "unset" is only a defensive fallback if one is ever missing.
				return [field, display.length > 60 ? display.slice(0, 57) + "..." : display, result.sources[field] || "unset"];
			}),
		);
		return;
	}

	exitUsage(`Unknown subcommand: config ${subcommand}\nAvailable: config show, config export`);
}
