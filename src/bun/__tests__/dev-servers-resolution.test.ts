/**
 * The rules every consumer of the dev-server list obeys: what a project
 * declares, which server an unnamed command means, and which declarations are
 * refused outright. The backend, the CLI bridge and the renderer all read this
 * one resolver, so a disagreement between them is impossible by construction.
 */
import { describe, it, expect } from "vitest";
import type { Project } from "../../shared/types";
import {
	DEV_SERVER_NAME_REQUIRED_CODE,
	devServerPortCount,
	devServerPortEnvKey,
	devServerScriptBase,
	resolveDevServerRef,
	resolveDevServers,
	splitAssignedPorts,
} from "../../shared/dev-servers";

function project(over: Partial<Pick<Project, "devScript" | "devServers">>): Pick<Project, "devScript" | "devServers"> {
	return { devScript: "", ...over };
}

describe("resolveDevServers", () => {
	it("reads a bare devScript as the single server named dev", () => {
		const { servers, errors } = resolveDevServers(project({ devScript: "bun run dev" }));
		expect(errors).toEqual([]);
		expect(servers).toHaveLength(1);
		expect(servers[0]).toMatchObject({ name: "dev", script: "bun run dev", isDefault: true, ports: [] });
	});

	it("declares nothing for an empty devScript", () => {
		expect(resolveDevServers(project({ devScript: "   " })).servers).toEqual([]);
	});

	// Adoption is incremental: the existing devScript keeps its meaning and its
	// position, and the new servers come after it.
	it("puts the default first and keeps declaration order for the rest", () => {
		const { servers } = resolveDevServers(project({
			devScript: "bun run dev",
			devServers: { api: { script: "bun run api" }, worker: { script: "bun run worker" } },
		}));
		expect(servers.map((server) => server.name)).toEqual(["dev", "api", "worker"]);
		expect(servers.filter((server) => server.isDefault)).toHaveLength(1);
	});

	it("collects every named port of the task, sorted and deduplicated", () => {
		const { namedPorts, errors } = resolveDevServers(project({
			devServers: {
				web: { script: "x", ports: ["web", "web"] },
				api: { script: "y", ports: ["api"] },
			},
		}));
		expect(errors).toEqual([]);
		expect(namedPorts).toEqual(["api", "web"]);
	});

	// One name, one source. Silently preferring either would make the UI show a
	// script that is not the one that runs.
	it("rejects `dev` declared beside devScript", () => {
		const { errors, servers } = resolveDevServers(project({
			devScript: "bun run dev",
			devServers: { dev: { script: "something else" } },
		}));
		expect(errors.join(" ")).toContain("declared twice");
		expect(servers.map((server) => server.name)).toEqual(["dev"]);
		expect(servers[0].script).toBe("bun run dev");
	});

	it("accepts `dev` in devServers when devScript is empty", () => {
		const { errors, servers } = resolveDevServers(project({ devServers: { dev: { script: "bun run dev" } } }));
		expect(errors).toEqual([]);
		expect(servers[0]).toMatchObject({ name: "dev", isDefault: true });
	});

	it("rejects two servers claiming one named port", () => {
		const { errors } = resolveDevServers(project({
			devServers: { api: { script: "x", ports: ["http"] }, admin: { script: "y", ports: ["http"] } },
		}));
		expect(errors.join(" ")).toContain('port "http" is claimed by both "api" and "admin"');
	});

	it("rejects an invalid name, an empty script and a cwd outside the worktree", () => {
		const { errors, servers } = resolveDevServers(project({
			devServers: {
				"Bad Name": { script: "x" },
				empty: { script: "  " },
				escapee: { script: "x", cwd: "../elsewhere" },
				absolute: { script: "x", cwd: "/etc" },
				fine: { script: "x", cwd: "packages/api" },
			},
		}));
		expect(servers.map((server) => server.name)).toEqual(["fine"]);
		expect(errors).toHaveLength(4);
	});
});

describe("resolveDevServerRef", () => {
	const withDefault = resolveDevServers(project({ devScript: "bun run dev", devServers: { api: { script: "x" } } }));
	const singleNamed = resolveDevServers(project({ devServers: { api: { script: "x" } } }));
	const severalNoDefault = resolveDevServers(project({ devServers: { api: { script: "x" }, web: { script: "y" } } }));

	it("resolves a name to that server", () => {
		expect(resolveDevServerRef(withDefault, "api")).toMatchObject({ server: { name: "api" } });
	});

	it("resolves no name to the default", () => {
		expect(resolveDevServerRef(withDefault)).toMatchObject({ server: { name: "dev" } });
	});

	// A single-server project should never have to spell its server's name.
	it("resolves no name to the only server when there is no default", () => {
		expect(resolveDevServerRef(singleNamed)).toMatchObject({ server: { name: "api" } });
	});

	it("refuses to guess between several servers, and names them", () => {
		const picked = resolveDevServerRef(severalNoDefault);
		expect(picked).not.toHaveProperty("server");
		if ("server" in picked) throw new Error("unreachable");
		expect(picked.code).toBe(DEV_SERVER_NAME_REQUIRED_CODE);
		expect(picked.candidates).toEqual(["api", "web"]);
		expect(picked.error).toContain("api, web");
	});

	it("reports an unknown name with the list of real ones", () => {
		const picked = resolveDevServerRef(withDefault, "nope");
		if ("server" in picked) throw new Error("unreachable");
		expect(picked.error).toContain("dev, api");
		expect(picked.code).toBeUndefined();
	});
});

describe("ports", () => {
	it("names a port's variable in upper case with dashes as underscores", () => {
		expect(devServerPortEnvKey("back-office")).toBe("DEV3_PORT_BACK_OFFICE");
	});

	// Positional first, then named sorted by name — the order allocation appends
	// in, so adding a server never renumbers DEV3_PORT0.
	it("splits an assignment into the positional block and the named ports", () => {
		expect(splitAssignedPorts([10001, 10002, 10003, 10004], 2, ["api", "web"])).toEqual({
			positional: [10001, 10002],
			named: { api: 10003, web: 10004 },
		});
		expect(devServerPortCount(2, ["api", "web"])).toBe(4);
	});

	it("leaves a named port out when the assignment is short of it", () => {
		expect(splitAssignedPorts([10001], 1, ["api"])).toEqual({ positional: [10001], named: {} });
	});

	it("names each server's generated script after it", () => {
		expect(devServerScriptBase("dev")).toBe("dev");
		expect(devServerScriptBase("api")).toBe("dev-api");
	});
});
