/**
 * A project's dev servers: the ordered list, their named ports, and the rules
 * that decide which one an unnamed command means.
 *
 * One project used to have exactly one `devScript`, so a task could run exactly
 * one process. `devServers` declares any number of them by name; `devScript`
 * stays exactly what it was and IS the server named `dev`. Nothing migrates
 * between the two — `.dev3/config.json` lives in other people's repositories and
 * `projects.json` is read by other installed versions of the app, so rewriting
 * either would break a reader that is not this process (see the decision record
 * `several-named-dev-servers-per-task`).
 *
 * Pure on purpose: the backend, the CLI bridge and the renderer all resolve the
 * same list from the same resolved project object, so none of them can invent a
 * different answer.
 */

import type { DevServerConfig, Project } from "./types";

/** The server a bare `devScript` declares, and the one an unnamed command means. */
export const DEFAULT_DEV_SERVER_NAME = "dev";

/** Lowercase letters, digits and dashes; never leading, trailing or doubled. */
export const DEV_SERVER_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Marker a "which server did you mean?" failure carries, so the CLI can map it
 * to its own exit code instead of pattern-matching English prose.
 */
export const DEV_SERVER_NAME_REQUIRED_CODE = "DEV3_DEV_SERVER_NAME_REQUIRED";

/** One declared dev server, with every optional field resolved. */
export interface ResolvedDevServer {
	name: string;
	script: string;
	/** Named ports this server listens on, in declaration order. */
	ports: string[];
	/** Extra environment for this server only, between the project env and the caller's. */
	env: Record<string, string>;
	/** Worktree-relative working directory, or null for the worktree root. */
	cwd: string | null;
	/** Display label for panes and the UI. */
	title: string;
	/** True for the server backed by `devScript`. */
	isDefault: boolean;
}

export interface DevServerResolution {
	/** Declaration order: `dev` first when `devScript` is set, then `devServers`. */
	servers: ResolvedDevServer[];
	/** Every distinct named port of the task, sorted — the order ports are assigned in. */
	namedPorts: string[];
	/** Config mistakes that must be shown rather than silently worked around. */
	errors: string[];
}

/** The environment variable one named port is delivered in. */
export function devServerPortEnvKey(portName: string): string {
	return `DEV3_PORT_${portName.toUpperCase().replaceAll("-", "_")}`;
}

/** Filename base of a server's generated wrapper script (`dev`, `dev-api`). */
export function devServerScriptBase(serverName: string): string {
	return serverName === DEFAULT_DEV_SERVER_NAME ? "dev" : `dev-${serverName}`;
}

function normalizeServer(name: string, raw: DevServerConfig, isDefault: boolean): ResolvedDevServer {
	return {
		name,
		script: raw.script ?? "",
		ports: [...new Set(raw.ports ?? [])],
		env: raw.env ?? {},
		cwd: raw.cwd?.trim() ? raw.cwd.trim() : null,
		title: raw.title?.trim() || (isDefault ? "Dev Server" : name),
		isDefault,
	};
}

/** A `cwd` that would take the server outside the worktree it belongs to. */
function escapesWorktree(cwd: string): boolean {
	if (cwd.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cwd)) return true;
	return cwd.split(/[\\/]/).includes("..");
}

/**
 * The task's dev servers, from a project whose config cascade is already
 * resolved (`resolveOperationalProjectConfig`). Never throws: a broken
 * declaration comes back in `errors` so the caller can show it next to the
 * servers that are fine.
 */
export function resolveDevServers(project: Pick<Project, "devScript" | "devServers">): DevServerResolution {
	const errors: string[] = [];
	const servers: ResolvedDevServer[] = [];
	const declared = project.devServers ?? {};
	const hasDevScript = !!project.devScript?.trim();

	if (hasDevScript) {
		servers.push(normalizeServer(DEFAULT_DEV_SERVER_NAME, { script: project.devScript }, true));
	}

	for (const [name, raw] of Object.entries(declared)) {
		if (!DEV_SERVER_NAME_PATTERN.test(name)) {
			errors.push(`"${name}" is not a valid dev server name (lowercase letters, digits and dashes)`);
			continue;
		}
		if (name === DEFAULT_DEV_SERVER_NAME && hasDevScript) {
			errors.push(
				`the dev server "dev" is declared twice: once as devScript and once in devServers — `
				+ `remove one of them`,
			);
			continue;
		}
		if (!raw || typeof raw !== "object" || !raw.script?.trim()) {
			errors.push(`dev server "${name}" has no script`);
			continue;
		}
		const server = normalizeServer(name, raw, name === DEFAULT_DEV_SERVER_NAME);
		if (server.cwd && escapesWorktree(server.cwd)) {
			errors.push(`dev server "${name}" has a cwd outside the worktree: ${server.cwd}`);
			continue;
		}
		const badPort = server.ports.find((port) => !DEV_SERVER_NAME_PATTERN.test(port));
		if (badPort) {
			errors.push(`dev server "${name}" declares an invalid port name: ${badPort}`);
			continue;
		}
		servers.push(server);
	}

	// A named port belongs to exactly one server: two servers claiming one port
	// means one of them silently loses the socket at runtime.
	const owner = new Map<string, string>();
	for (const server of servers) {
		for (const port of server.ports) {
			const first = owner.get(port);
			if (first) errors.push(`port "${port}" is claimed by both "${first}" and "${server.name}"`);
			else owner.set(port, server.name);
		}
	}

	return { servers, namedPorts: [...owner.keys()].sort(), errors };
}

export type DevServerRefResult =
	| { server: ResolvedDevServer }
	| { error: string; code?: typeof DEV_SERVER_NAME_REQUIRED_CODE; candidates: string[] };

/**
 * Which server a command means.
 *
 * A name resolves to that server. No name resolves to the default (`devScript`),
 * or — when a project declares exactly one server and no default — to that one,
 * so a single-server project never has to spell its name. Several servers and no
 * default is the one case nobody can guess: it fails with the list of names and a
 * code the CLI turns into its own exit status.
 */
export function resolveDevServerRef(
	resolution: DevServerResolution,
	name?: string | null,
): DevServerRefResult {
	const candidates = resolution.servers.map((server) => server.name);
	if (name) {
		const found = resolution.servers.find((server) => server.name === name);
		if (found) return { server: found };
		return {
			error: candidates.length > 0
				? `no dev server named "${name}" — this project declares: ${candidates.join(", ")}`
				: `no dev server named "${name}" — this project declares none`,
			candidates,
		};
	}
	const fallback = resolution.servers.find((server) => server.isDefault) ?? (resolution.servers.length === 1 ? resolution.servers[0] : undefined);
	if (fallback) return { server: fallback };
	if (resolution.servers.length === 0) return { error: "No dev script configured", candidates };
	return {
		error: `${DEV_SERVER_NAME_REQUIRED_CODE}: this project declares several dev servers and none of them is the default — name one: ${candidates.join(", ")}`,
		code: DEV_SERVER_NAME_REQUIRED_CODE,
		candidates,
	};
}

/**
 * Split a task's assigned pool ports into the positional ones (`DEV3_PORT0..N`,
 * exactly what `portCount` asked for) and the named ones. Allocation appends
 * named ports after the positional block in sorted order, so the split is
 * positional-first and stable as servers are added.
 */
export function splitAssignedPorts(
	assigned: number[],
	portCount: number,
	namedPorts: string[],
): { positional: number[]; named: Record<string, number> } {
	const positional = assigned.slice(0, Math.max(0, portCount));
	const named: Record<string, number> = {};
	namedPorts.forEach((portName, index) => {
		const port = assigned[Math.max(0, portCount) + index];
		if (port !== undefined) named[portName] = port;
	});
	return { positional, named };
}

/** How many pool ports a task needs: its positional block plus one per named port. */
export function devServerPortCount(portCount: number, namedPorts: string[]): number {
	return Math.max(0, portCount) + namedPorts.length;
}
