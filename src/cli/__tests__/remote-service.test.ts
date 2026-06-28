import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
	mkdirSync: vi.fn(),
	writeFileSync: vi.fn(),
	unlinkSync: vi.fn(),
	realpathSync: vi.fn((p: string) => p),
}));
vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(() => ({ status: 0, stdout: "/usr/bin/systemctl\n" })),
}));

import {
	buildExecStartArgs,
	renderUnitFile,
	installRemoteService,
	uninstallRemoteService,
} from "../commands/remote-service";
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { ParsedArgs } from "../args";

function args(flags: Record<string, string> = {}, positional: string[] = []): ParsedArgs {
	return { positional, flags };
}

const origPlatform = process.platform;
const origExecPath = process.execPath;
const origHome = process.env.HOME;
const origUser = process.env.USER;
const origXdg = process.env.XDG_CONFIG_HOME;

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
	vi.clearAllMocks();
});

const stdoutText = () => stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
const stderrText = () => stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");

describe("buildExecStartArgs", () => {
	it("defaults to `remote start` with no extra flags", () => {
		expect(buildExecStartArgs(args())).toEqual(["remote", "start"]);
	});

	it("maps --port / --no-tunnel / --expose-ports / --static-code", () => {
		const out = buildExecStartArgs(args({ port: "3017", "no-tunnel": "true", "expose-ports": "3000,5173", "static-code": "letmein" }));
		expect(out).toEqual(["remote", "start", "--port", "3017", "--no-tunnel", "--expose-ports=3000,5173", "--static-code=letmein"]);
	});

	it("never includes --detach (systemd owns the foreground process)", () => {
		expect(buildExecStartArgs(args({ port: "3017" }))).not.toContain("--detach");
	});

	it("rejects an invalid port", () => {
		expect(() => buildExecStartArgs(args({ port: "abc" }))).toThrow("__exit__");
		expect(stderrText()).toContain("--port must be an integer");
	});
});

describe("renderUnitFile", () => {
	it("renders a valid systemd unit", () => {
		const unit = renderUnitFile("/usr/local/bin/dev3", ["remote", "start", "--port", "3017"]);
		expect(unit).toContain("ExecStart=/usr/local/bin/dev3 remote start --port 3017");
		expect(unit).toContain("Type=simple");
		expect(unit).toContain("Restart=on-failure");
		expect(unit).toContain("WantedBy=default.target");
	});
});

describe("installRemoteService", () => {
	it("refuses on non-Linux platforms", async () => {
		setPlatform("darwin");
		await expect(installRemoteService(args())).rejects.toThrow("__exit__");
		expect(stderrText()).toContain("Linux-only");
	});

	it("refuses when running via bun (no compiled binary)", async () => {
		setPlatform("linux");
		process.execPath = "/opt/homebrew/bin/bun";
		await expect(installRemoteService(args())).rejects.toThrow("__exit__");
		expect(stderrText()).toContain("compiled dev3 binary");
	});

	it("writes the unit and enables it via systemctl", async () => {
		setPlatform("linux");
		await installRemoteService(args({ port: "3017" }));
		expect(mkdirSync).toHaveBeenCalledWith("/home/tester/.config/systemd/user", { recursive: true });
		const writeCall = vi.mocked(writeFileSync).mock.calls[0];
		expect(writeCall[0]).toBe("/home/tester/.config/systemd/user/dev3-remote.service");
		expect(String(writeCall[1])).toContain("ExecStart=/usr/local/bin/dev3 remote start --port 3017");
		// daemon-reload + enable --now
		const cmds = vi.mocked(spawnSync).mock.calls.map((c) => [c[0], ...(c[1] as string[])].join(" "));
		expect(cmds.some((c) => c.includes("daemon-reload"))).toBe(true);
		expect(cmds.some((c) => c.includes("enable --now dev3-remote.service"))).toBe(true);
		expect(stdoutText()).toContain("enabled and started");
	});

	it("warns when no --port is given", async () => {
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
	it("refuses on non-Linux platforms", async () => {
		setPlatform("darwin");
		await expect(uninstallRemoteService(args())).rejects.toThrow("__exit__");
		expect(stderrText()).toContain("Linux-only");
	});

	it("disables and removes the unit on Linux", async () => {
		setPlatform("linux");
		await uninstallRemoteService(args());
		expect(unlinkSync).toHaveBeenCalledWith("/home/tester/.config/systemd/user/dev3-remote.service");
		const cmds = vi.mocked(spawnSync).mock.calls.map((c) => [c[0], ...(c[1] as string[])].join(" "));
		expect(cmds.some((c) => c.includes("disable --now dev3-remote.service"))).toBe(true);
		expect(stdoutText()).toContain("stopped and disabled");
	});
});
