import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
	mkdirSync: vi.fn(),
	writeFileSync: vi.fn(),
	readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
	unlinkSync: vi.fn(),
	realpathSync: vi.fn((p: string) => p),
}));
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(() => ({ status: 0, stdout: "/usr/bin/systemctl\n" })),
}));

import {
	buildExecStartArgs,
	collectServiceEnv,
	mergeServiceEnv,
	parseUnitServiceEnv,
	renderUnitFile,
	SERVICE_ENV_KEYS,
	installRemoteService,
	uninstallRemoteService,
} from "../commands/remote-service";
import { writeFileSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { ParsedArgs } from "../args";
import { MIN_REMOTE_STATIC_CODE_LENGTH } from "../../shared/remote-static-code";

function args(flags: Record<string, string> = {}, positional: string[] = []): ParsedArgs {
	return { positional, flags };
}

const origPlatform = process.platform;
const origExecPath = process.execPath;
const origHome = process.env.HOME;
const origUser = process.env.USER;
const origXdg = process.env.XDG_CONFIG_HOME;
const origServiceEnv = Object.fromEntries(SERVICE_ENV_KEYS.map((k) => [k, process.env[k]]));

function setPlatform(p: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: p, configurable: true });
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	exitSpy = vi.spyOn(process, "exit").mockImplementation(((_c?: number) => { throw new Error("__exit__"); }) as never);
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	process.execPath = "/usr/local/bin/dev3";
	process.env.HOME = "/home/tester";
	process.env.USER = "tester";
	delete process.env.XDG_CONFIG_HOME;
	for (const k of SERVICE_ENV_KEYS) delete process.env[k];
	vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "/usr/bin/systemctl\n" } as never);
});

afterEach(() => {
	exitSpy.mockRestore();
	stdoutSpy.mockRestore();
	stderrSpy.mockRestore();
	setPlatform(origPlatform);
	process.execPath = origExecPath;
	process.env.HOME = origHome;
	process.env.USER = origUser;
	if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = origXdg;
	for (const [k, v] of Object.entries(origServiceEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	vi.clearAllMocks();
});

const stdoutText = () => stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
const stderrText = () => stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");

describe("buildExecStartArgs", () => {
	// --no-detach is forced so systemd keeps the foreground process (never bare --detach).
	it("defaults to `remote start --no-detach` and maps --port / --no-tunnel / --expose-ports / --static-code / --host", () => {
		expect(buildExecStartArgs(args())).toEqual(["remote", "start", "--no-detach"]);
		const out = buildExecStartArgs(args({ port: "3017", "no-tunnel": "true", "expose-ports": "3000,5173", "static-code": "letmein1" }));
		expect(out).toEqual(["remote", "start", "--no-detach", "--port", "3017", "--no-tunnel", "--expose-ports=3000,5173", "--static-code=letmein1"]);
		expect(buildExecStartArgs(args({ host: "127.0.0.1", "no-tunnel": "true" }))).toEqual(["remote", "start", "--no-detach", "--host", "127.0.0.1", "--no-tunnel"]);
		expect(stderrText(), "quiet about the tunnel with --no-tunnel").not.toContain("public tunnel is on");
	});

	it("rejects a --host other than 127.0.0.1/localhost/0.0.0.0, an invalid port, and a valueless --static-code", () => {
		expect(() => buildExecStartArgs(args({ host: "example.com" }))).toThrow("__exit__");
		expect(stderrText()).toContain("--host must be 127.0.0.1, localhost or 0.0.0.0");
		expect(() => buildExecStartArgs(args({ port: "abc" }))).toThrow("__exit__");
		expect(stderrText()).toContain("--port must be an integer");
		expect(() => buildExecStartArgs(args({ "static-code": "true" }))).toThrow("__exit__");
		expect(stderrText()).toContain("--static-code requires a value");
	});

	// F1: install-service must enforce the same minimum that `remote start`
	// does — otherwise systemd Restart=on-failure loops forever on a too-short code.
	it("rejects a static-code shorter than the minimum (no silent systemd restart loop)", () => {
		expect(() => buildExecStartArgs(args({ "static-code": "ab" }))).toThrow("__exit__");
		expect(stderrText()).toContain(`--static-code must be at least ${MIN_REMOTE_STATIC_CODE_LENGTH} characters`);
	});

	// Literal 7/8: a boundary expressed via MIN_… would move with the constant and
	// survive someone lowering it, which is exactly the regression to catch.
	it("rejects a 7-character code — the minimum is pinned at 8", () => {
		expect(MIN_REMOTE_STATIC_CODE_LENGTH).toBe(8);
		expect(() => buildExecStartArgs(args({ "static-code": "abcdefg", "no-tunnel": "true" }))).toThrow("__exit__");
		expect(buildExecStartArgs(args({ "static-code": "abcdefgh", "no-tunnel": "true" }))).toContain("--static-code=abcdefgh");
	});

	// Boundary, both sides — relative to the constant, so it keeps holding if the
	// minimum is ever raised.
	it("rejects one character below the minimum and accepts exactly the minimum", () => {
		const tooShort = "a".repeat(MIN_REMOTE_STATIC_CODE_LENGTH - 1);
		expect(() => buildExecStartArgs(args({ "static-code": tooShort, "no-tunnel": "true" }))).toThrow("__exit__");

		const exact = "a".repeat(MIN_REMOTE_STATIC_CODE_LENGTH);
		expect(buildExecStartArgs(args({ "static-code": exact, "no-tunnel": "true" }))).toContain(`--static-code=${exact}`);
	});

	// F7: systemd splits ExecStart on whitespace, so a code with a space would be
	// parsed as extra positional args and crash the server on every start.
	it("rejects a static-code containing whitespace (breaks systemd ExecStart)", () => {
		expect(() => buildExecStartArgs(args({ "static-code": "hello world" }))).toThrow("__exit__");
		expect(stderrText()).toContain("must not contain whitespace");
	});

	// The combination is legitimate — it is how you sign in to a headless box from
	// a phone — so the unit is written and the user is told what it means.
	it("warns but still writes the unit for --static-code without --no-tunnel", () => {
		const out = buildExecStartArgs(args({ "static-code": "letmein1" }));
		expect(out).toContain("--static-code=letmein1");
		expect(out).not.toContain("--no-tunnel");
		expect(stderrText()).toContain("public tunnel is on");
	});
});

describe("renderUnitFile", () => {
	it("renders a valid systemd unit", () => {
		const unit = renderUnitFile("/usr/local/bin/dev3", ["remote", "start", "--port", "3017"]);
		expect(unit).toContain("ExecStart=/usr/local/bin/dev3 remote start --port 3017");
		expect(unit).toContain("Type=simple");
		expect(unit).toContain("Restart=on-failure");
		expect(unit).toContain("WantedBy=default.target");
		expect(unit, "nothing carried").not.toContain("Environment=");
	});
});

describe("collectServiceEnv", () => {
	it("keeps only allowlisted, non-empty variables, making a relative DEV3_HOME absolute (systemd runs from ~)", () => {
		const env = collectServiceEnv({
			DEV3_TELEMETRY: "off",
			DO_NOT_TRACK: "1",
			DEV3_LOG_LEVEL: "  ",
			DEV3_TASK_ID: "995eea36",
			DEV3_REMOTE_PORT: "8090",
			DEV3_REMOTE_STATIC_CODE: "letmein1",
		});
		expect(env).toEqual([["DEV3_TELEMETRY", "off"], ["DO_NOT_TRACK", "1"]]);
		expect(collectServiceEnv({ DEV3_HOME: "rel/home" })).toEqual([["DEV3_HOME", `${process.cwd()}/rel/home`]]);
	});

	it("rejects a value with a newline (would split the unit line)", () => {
		expect(() => collectServiceEnv({ DEV3_HOME: "/a\nExecStartPre=/bin/evil" })).toThrow("__exit__");
		expect(stderrText()).toContain("control character");
	});
});

describe("renderUnitFile environment", () => {
	it("writes Environment= lines in [Service] before ExecStart, escaping quotes, backslashes and % specifiers", () => {
		const unit = renderUnitFile("/usr/local/bin/dev3", ["remote", "start"], [["DEV3_TELEMETRY", "off"]]);
		const lines = unit.split("\n");
		const envIdx = lines.indexOf('Environment="DEV3_TELEMETRY=off"');
		expect(envIdx).toBeGreaterThan(lines.indexOf("[Service]"));
		expect(envIdx).toBeLessThan(lines.findIndex((l) => l.startsWith("ExecStart=")));
		const escaped = renderUnitFile("/bin/dev3", [], [["DEV3_HOME", '/srv/a b/"q"\\x%h']]);
		expect(escaped).toContain('Environment="DEV3_HOME=/srv/a b/\\"q\\"\\\\x%%h"');
	});

});

describe("parseUnitServiceEnv", () => {
	it("round-trips what renderUnitFile wrote, and ignores keys outside the allowlist", () => {
		const env: Array<[string, string]> = [["DEV3_TELEMETRY", "off"], ["DEV3_HOME", '/srv/a b/"q"\\x%h']];
		expect(parseUnitServiceEnv(renderUnitFile("/bin/dev3", [], env))).toEqual(env);
		expect(parseUnitServiceEnv('[Service]\nEnvironment="PATH=/x"\nEnvironment="DO_NOT_TRACK=1"\n')).toEqual([["DO_NOT_TRACK", "1"]]);
	});

});

describe("mergeServiceEnv", () => {
	it("prefers the shell and keeps previous values the shell does not set", () => {
		const { env, kept } = mergeServiceEnv(
			[["DEV3_LOG_LEVEL", "debug"]],
			[["DEV3_TELEMETRY", "off"], ["DEV3_LOG_LEVEL", "info"]],
		);
		expect(env).toEqual([["DEV3_TELEMETRY", "off"], ["DEV3_LOG_LEVEL", "debug"]]);
		expect(kept).toEqual([["DEV3_TELEMETRY", "off"]]);
	});
});

describe("installRemoteService", () => {
	it("keeps DEV3_TELEMETRY=off from the previous unit when re-run from a shell without it", async () => {
		setPlatform("linux");
		vi.mocked(readFileSync).mockReturnValueOnce(renderUnitFile("/bin/dev3", [], [["DEV3_TELEMETRY", "off"]]));
		await installRemoteService(args({ port: "4000" }));
		expect(String(vi.mocked(writeFileSync).mock.calls[0][1])).toContain('Environment="DEV3_TELEMETRY=off"');
		expect(stdoutText()).toContain("Kept from the previous unit");
		expect(stdoutText()).not.toContain("No environment carried");
	});

	it("carries DEV3_TELEMETRY from the shell into the unit and says so", async () => {
		setPlatform("linux");
		process.env.DEV3_TELEMETRY = "off";
		await installRemoteService(args({ port: "3017" }));
		const unit = String(vi.mocked(writeFileSync).mock.calls[0][1]);
		expect(unit).toContain('Environment="DEV3_TELEMETRY=off"');
		expect(unit).not.toContain("DEV3_TASK_ID");
		expect(stdoutText()).toContain("Carried from this shell into the unit:");
		expect(stdoutText()).toContain("DEV3_TELEMETRY=off");
	});

	it("refuses on non-Linux platforms (install and uninstall) and when running via bun", async () => {
		setPlatform("darwin");
		await expect(installRemoteService(args())).rejects.toThrow("__exit__");
		await expect(uninstallRemoteService(args())).rejects.toThrow("__exit__");
		expect(stderrText()).toContain("Linux-only");
		expect(unlinkSync).not.toHaveBeenCalled();

		setPlatform("linux");
		process.execPath = "/opt/homebrew/bin/bun";
		await expect(installRemoteService(args())).rejects.toThrow("__exit__");
		expect(stderrText()).toContain("compiled dev3 binary");
	});

	it("writes the unit and enables it via systemctl, warning when no --port is given", async () => {
		setPlatform("linux");
		await installRemoteService(args({ port: "3017" }));
		expect(mkdirSync).toHaveBeenCalledWith("/home/tester/.config/systemd/user", { recursive: true });
		const writeCall = vi.mocked(writeFileSync).mock.calls[0];
		expect(writeCall[0]).toBe("/home/tester/.config/systemd/user/dev3-remote.service");
		expect(String(writeCall[1])).toContain("ExecStart=/usr/local/bin/dev3 remote start --no-detach --port 3017");
		// daemon-reload + enable --now
		const cmds = vi.mocked(spawnSync).mock.calls.map((c) => [c[0], ...(c[1] as string[])].join(" "));
		expect(cmds.some((c) => c.includes("daemon-reload"))).toBe(true);
		expect(cmds.some((c) => c.includes("enable --now dev3-remote.service"))).toBe(true);
		expect(stdoutText()).toContain("enabled and started");
		expect(String(writeCall[1])).not.toContain("Environment=");
		expect(stdoutText()).toContain("No environment carried");
		setPlatform("linux");
		await installRemoteService(args());
		expect(stdoutText()).toContain("No --port given");
	});

	it("respects --no-start (enable without --now)", async () => {
		setPlatform("linux");
		await installRemoteService(args({ port: "3017", "no-start": "true" }));
		const cmds = vi.mocked(spawnSync).mock.calls.map((c) => [c[0], ...(c[1] as string[])].join(" "));
		expect(cmds.some((c) => c.includes("enable dev3-remote.service"))).toBe(true);
		expect(cmds.some((c) => c.includes("--now"))).toBe(false);
	});
});

describe("uninstallRemoteService", () => {
	it("disables and removes the unit on Linux", async () => {
		setPlatform("linux");
		await uninstallRemoteService(args());
		expect(unlinkSync).toHaveBeenCalledWith("/home/tester/.config/systemd/user/dev3-remote.service");
		const cmds = vi.mocked(spawnSync).mock.calls.map((c) => [c[0], ...(c[1] as string[])].join(" "));
		expect(cmds.some((c) => c.includes("disable --now dev3-remote.service"))).toBe(true);
		expect(stdoutText()).toContain("stopped and disabled");
	});
});
