import type { Project } from "../../shared/types";
import { sendRequest } from "../socket-client";
import { printTable, exitError } from "../output";
import type { ParsedArgs } from "../args";

export async function handleProjects(subcommand: string | undefined, _args: ParsedArgs, socketPath: string): Promise<void> {
	if (subcommand === "list" || !subcommand) {
		const resp = await sendRequest(socketPath, "projects.list");
		if (!resp.ok) exitError(resp.error || "Failed to list projects");

		const projects = resp.data as Project[];
		if (projects.length === 0) {
			process.stdout.write("No projects configured.\n");
			return;
		}

		printTable(
			["ID", "NAME", "PATH"],
			projects.map((p) => [p.id.slice(0, 8), p.name, p.path]),
		);
		return;
	}

	exitError(`Unknown subcommand: projects ${subcommand}`, "Available: projects list", 3);
}
