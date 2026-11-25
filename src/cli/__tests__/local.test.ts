import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { expandLocalAlias, localHostError, LOCAL_HELP } from "../commands/local";
import { parseArgs } from "../args";
import { buildExecStartArgs } from "../commands/remote-service";
import { computeDetachedChildArgs } from "../commands/remote";

vi.mock("../../bun/headless-entry", () => ({}));

/** The flags `main()` would hand `handleRemote` for this `dev3 …` argv. */
function remoteFlags(rawArgs: string[]): Record<string, string> {
	const expanded = expandLocalAlias(rawArgs);
	const subcommand = expanded[1] && !expanded[1].startsWith("--") ? expanded[1] : undefined;
	return parseArgs(expanded.slice(subcommand ? 2 : 1)).flags;
}

describe("expandLocalAlias", () => {
	it("turns bare `local` into a loopback, tunnel-less `remote` start, keeping user flags after the alias flags", () => {
		expect(expandLocalAlias(["local"])).toEqual(["remote", "--no-tunnel", "--host", "127.0.0.1"]);
		expect(expandLocalAlias(["local", "--port", "8090", "--no-detach"])).toEqual([
			"remote", "--no-tunnel", "--host", "127.0.0.1", "--port", "8090", "--no-detach",
		]);
	});

	it("adds the alias flags to the starting subcommands and passes the others through unchanged", () => {
		for (const sub of ["start", "restart", "install-service"]) {
			expect(expandLocalAlias(["local", sub, "--port", "8090"]), sub).toEqual([
				"remote", sub, "--no-tunnel", "--host", "127.0.0.1", "--port", "8090",
			]);
		}
		for (const sub of ["status", "url", "logs", "stop", "uninstall-service"]) {
			expect(expandLocalAlias(["local", sub, "--lines", "5"]), sub).toEqual(["remote", sub, "--lines", "5"]);
		}
	});

	it("parses into the same flags as the long form, and a user --host overrides the default", () => {
		expect(remoteFlags(["local", "--port", "8090"])).toEqual(
			parseArgs(["--no-tunnel", "--host", "127.0.0.1", "--port", "8090"]).flags,
		);
		expect(remoteFlags(["local", "--host", "localhost"]).host).toBe("localhost");
	});
});

describe("localHostError", () => {
	const check = (argv: string[]) => localHostError(expandLocalAlias(argv));

	it("accepts a loopback bind, leaves a bare --host to remote, and ignores subcommands that start nothing", () => {
		for (const argv of [
			["local"],
			["local", "--host", "localhost"],
			["local", "start", "--host", "127.0.0.1"],
			["local", "install-service", "--host=localhost"],
			["local", "--host"],
			["local", "status", "--host", "0.0.0.0"],
		]) {
			expect(check(argv), argv.join(" ")).toBeNull();
		}
	});

	it("refuses a bind beyond this machine", () => {
		for (const argv of [
			["local", "--host", "0.0.0.0"],
			["local", "restart", "--host", "0.0.0.0"],
			["local", "install-service", "--host=0.0.0.0"],
			["local", "--host", "1.2.3.4"],
		]) {
			expect(check(argv), argv.join(" ")).toContain("this machine only");
		}
	});
});

describe("dev3 local install-service", () => {
	let stderrSpy: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});
	afterEach(() => stderrSpy.mockRestore());

	it("writes a loopback-only, tunnel-less unit", () => {
		const execArgs = buildExecStartArgs(parseArgs(expandLocalAlias(["local", "install-service", "--port", "8090"]).slice(2)));
		expect(execArgs).toEqual(["remote", "start", "--no-detach", "--port", "8090", "--host", "127.0.0.1", "--no-tunnel"]);
	});
});

describe("dev3 local in the background", () => {
	it("re-runs the alias in the detached child, so it expands the same way again", () => {
		const child = computeDetachedChildArgs(["/usr/local/bin/dev3", "/$bunfs/root/dev3", "local", "--port", "8090"], "/usr/local/bin/dev3");
		expect(child).toEqual(["local", "--port", "8090", "--no-detach"]);
	});
});

describe("LOCAL_HELP", () => {
	it("names the flags it adds and points at the full remote help", () => {
		expect(LOCAL_HELP).toContain("dev3 remote --no-tunnel --host 127.0.0.1");
		expect(LOCAL_HELP).toContain("dev3 remote --help");
	});
});
