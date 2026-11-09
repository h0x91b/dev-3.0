import { describe, expect, it } from "vitest";
import { agentCommandExecutable } from "../../shared/agent-command-executable";
import { launchDialect } from "../../shared/platform-launch";

const posix = (command: string) => agentCommandExecutable(command, "linux");
const windows = (command: string) => agentCommandExecutable(command, "win32");
const name = (value: string) => ({ kind: "name", name: value });
const path = (value: string) => ({ kind: "path", path: value });
const unknown = { kind: "unknown" };

describe("agentCommandExecutable (posix shell text)", () => {
	it("reads a bare command as a PATH name", () => {
		expect(posix("claude")).toEqual(name("claude"));
	});

	it("ignores the subcommand and arguments after the executable", () => {
		expect(posix("opencode mini")).toEqual(name("opencode"));
		expect(posix("npx claude --verbose")).toEqual(name("npx"));
	});

	// The issue #2218 shape: `env <absolute path> <subcommand>`.
	it("looks through `env` to the executable it runs", () => {
		expect(posix("env /opt/mise/shims/opencode mini")).toEqual(path("/opt/mise/shims/opencode"));
		expect(posix("env opencode mini")).toEqual(name("opencode"));
	});

	it("skips env assignments, before and after `env`", () => {
		expect(posix("FOO=1 BAR=two claude")).toEqual(name("claude"));
		expect(posix("env FOO=1 BAR='a b' /opt/bin/opencode mini")).toEqual(path("/opt/bin/opencode"));
		expect(posix("FOO=1 env BAR=2 claude")).toEqual(name("claude"));
	});

	it("skips the env options it understands", () => {
		expect(posix("env -i PATH=/bin claude")).toEqual(name("claude"));
		expect(posix("env -u NODE_OPTIONS claude")).toEqual(name("claude"));
		expect(posix("env --unset=NODE_OPTIONS -- claude")).toEqual(name("claude"));
	});

	it("gives up on an env option it does not understand", () => {
		expect(posix("env -S 'claude --flag'")).toEqual(unknown);
		expect(posix("env -C /tmp claude")).toEqual(unknown);
	});

	it("resolves quoting and escapes in the executable word", () => {
		expect(posix("env '/opt/my tools/opencode' mini")).toEqual(path("/opt/my tools/opencode"));
		expect(posix('env "/opt/my tools/opencode" mini')).toEqual(path("/opt/my tools/opencode"));
		expect(posix("env /opt/my\\ tools/opencode mini")).toEqual(path("/opt/my tools/opencode"));
	});

	it("treats one absolute path as the whole command, spaces included", () => {
		expect(posix("/opt/bin/claude")).toEqual(path("/opt/bin/claude"));
		expect(posix("/opt/my tools/claude")).toEqual(path("/opt/my tools/claude"));
	});

	it.each([
		["a variable in the executable", "$HOME/bin/opencode mini"],
		["a home-relative path", "~/bin/opencode mini"],
		["a command substitution", "$(which opencode) mini"],
		["a relative path", "./bin/opencode mini"],
		["a nested relative path", "bin/opencode"],
		["a shell builtin", "exec opencode mini"],
		["a chained command", "cd /srv && claude"],
		["an unterminated quote", "env 'opencode mini"],
		["nothing to run", "env FOO=1"],
		["an empty command", "   "],
	])("cannot tell for %s", (_label, command) => {
		expect(posix(command)).toEqual(unknown);
	});

	it("does not mistake a later operator for part of the executable", () => {
		expect(posix("opencode mini | tee log")).toEqual(name("opencode"));
	});
});

describe("agentCommandExecutable (windows)", () => {
	it("treats an absolute path as the whole command", () => {
		expect(windows("C:\\Program Files\\Claude\\claude.exe")).toEqual(path("C:\\Program Files\\Claude\\claude.exe"));
	});

	it("reads the first word of shell text, keeping backslashes", () => {
		expect(windows("npx claude")).toEqual(name("npx"));
		expect(windows("opencode.cmd mini")).toEqual(name("opencode.cmd"));
	});

	it("does not apply posix-only syntax", () => {
		expect(windows("env opencode mini")).toEqual(name("env"));
	});

	it("cannot tell for a call operator, a variable or a relative path", () => {
		expect(windows("& 'C:\\Program Files\\claude.exe' --flag")).toEqual(unknown);
		expect(windows("$env:LOCALAPPDATA\\claude.exe")).toEqual(unknown);
		expect(windows(".\\bin\\claude.exe")).toEqual(unknown);
	});
});

// The check and the launch must split a command on the same rule: whatever
// `commandToken` quotes whole is one path, never a path plus arguments.
describe("agentCommandExecutable mirrors commandToken", () => {
	it.each([
		["linux", "/opt/my tools/claude"],
		["win32", "C:\\Program Files\\Claude\\claude.exe"],
	] as const)("%s: a command quoted whole is one path", (platform, command) => {
		expect(launchDialect(platform).commandToken(command)).not.toBe(command);
		expect(agentCommandExecutable(command, platform)).toEqual(path(command));
	});

	it.each([
		["linux", "env /opt/bin/opencode mini"],
		["win32", "npx claude"],
	] as const)("%s: a command left as shell text is parsed as words", (platform, command) => {
		expect(launchDialect(platform).commandToken(command)).toBe(command);
		expect(agentCommandExecutable(command, platform).kind).not.toBe("unknown");
	});
});
