import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { expandLocalAlias, LOCAL_HELP } from "../commands/local";
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
	it("turns bare `local` into a loopback, tunnel-less `remote` start", () => {
		expect(expandLocalAlias(["local"])).toEqual(["remote", "--no-tunnel", "--host", "127.0.0.1"]);
	});

	it("keeps user flags after the alias flags", () => {
		expect(expandLocalAlias(["local", "--port", "8090", "--no-detach"])).toEqual([
			"remote", "--no-tunnel", "--host", "127.0.0.1", "--port", "8090", "--no-detach",
		]);
	});

	it.each(["start", "restart", "install-service"])("adds the alias flags to `%s`", (sub) => {
		expect(expandLocalAlias(["local", sub, "--port", "8090"])).toEqual([
			"remote", sub, "--no-tunnel", "--host", "127.0.0.1", "--port", "8090",
		]);
	});

	it.each(["status", "url", "logs", "stop", "uninstall-service"])("passes `%s` through unchanged", (sub) => {
		expect(expandLocalAlias(["local", sub, "--lines", "5"])).toEqual(["remote", sub, "--lines", "5"]);
	});

	it("parses into the same flags as the long form", () => {
		expect(remoteFlags(["local", "--port", "8090"])).toEqual(
			parseArgs(["--no-tunnel", "--host", "127.0.0.1", "--port", "8090"]).flags,
		);
	});

	it("lets a user --host override the alias default", () => {
		expect(remoteFlags(["local", "--host", "localhost"]).host).toBe("localhost");
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
