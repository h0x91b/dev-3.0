/**
 * POSIX byte-identity golden test for the platform launch dialect.
 *
 * Every wrapper script dev3 generates on macOS/Linux is pinned here as the
 * literal text the pre-dialect code produced. The dialect refactor is only
 * correct if these strings do not move: a diff means every existing task
 * terminal changes behaviour on the next launch.
 *
 * Regenerate by hand ONLY together with a deliberate, reviewed change to what
 * the user sees in the terminal.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
	buildAgentRetryWrapper,
	buildCmdScript,
	buildEnvExports,
	buildScriptRunnerCommand,
	buildSetupStartupWrapper,
	portableReadKey,
} from "../rpc-handlers/shared-pure";
import { ENV_UNSET } from "../../shared/agent-accounts";

const SHELL = "/bin/zsh";
const SETUP_PATH = "/tmp/dev3-T-setup.sh";
const CMD_PATH = "/tmp/dev3-T-cmd.sh";
const SETUP_EXIT_PATH = "/tmp/dev3-T-setup-exit";
const ORIGINAL_CMD_PATH = "/tmp/dev3-T-original-cmd.sh";
const WORKTREE = "/w/t";

const RUN_WRAPPER_KEEP_SHELL = [
	"#!/bin/bash",
	"printf '\\033]2;Agent\\033\\\\'",
	"export FOO='bar baz'",
	"echo \"Starting: claude 'Fix bug'\" && claude 'Fix bug'",
	"__EC=$?",
	"if [ $__EC -ne 0 ]; then",
	"  printf '\\n\\033[1;31m✗ Process exited with code %s\\033[0m\\n' \"$__EC\"",
	"else",
	"  printf '\\n\\033[2mAgent session ended (exit 0). You are in the worktree shell.\\033[0m\\n'",
	"fi",
	"exec '/bin/zsh'",
].join("\n") + "\n";

const RUN_WRAPPER_NO_KEEP_SHELL = [
	"#!/bin/bash",
	"export FOO='bar baz'",
	"echo \"Starting: claude 'Fix bug'\" && claude 'Fix bug'",
	"__EC=$?",
	"if [ $__EC -ne 0 ]; then",
	"  printf '\\n\\033[1;31m✗ Process exited with code %s\\033[0m\\n' \"$__EC\"",
	"  exec '/bin/zsh'",
	"else",
	"echo bye",
	"fi",
].join("\n") + "\n";

const RUN_WRAPPER_DEFAULT_SHELL = [
	"#!/bin/bash",
	"echo \"Starting: claude\" && claude",
	"__EC=$?",
	"if [ $__EC -ne 0 ]; then",
	"  printf '\\n\\033[1;31m✗ Process exited with code %s\\033[0m\\n' \"$__EC\"",
	"  exec '/bin/bash'",
	"fi",
].join("\n") + "\n";

const AGENT_RETRY_WRAPPER = [
	"#!/bin/bash",
	"",
	"check_and_run() {",
	"  if command -v 'claude' &>/dev/null; then",
	"    printf '\\n\\033[1;32m✓ Found %s\\033[0m\\n\\n' 'claude'",
	"    exec '/bin/zsh' '/tmp/dev3-T-original-cmd.sh'",
	"  fi",
	"}",
	"",
	"while true; do",
	"  printf '\\033[1;31m✗ Agent not found: %s\\033[0m\\n\\n' 'claude'",
	"  printf '\\033[1mInstall:\\033[0m %s\\n' 'npm i -g claude'",
	"  printf '\\033[2mAfter installing, run \"%s\" once in a terminal to log in.\\033[0m\\n' 'claude'",
	"  printf '\\033[2mInstallation and setup are not managed by dev-3.0.\\033[0m\\n\\n'",
	"  printf 'Press \\033[1mEnter\\033[0m to retry...\\n'",
	"  read -r",
	"  check_and_run",
	"done",
].join("\n") + "\n";

const STARTUP_WRAPPER_NATIVE = [
	"#!/bin/bash",
	"'/bin/zsh' -x '/tmp/dev3-T-setup.sh'",
	"S=$?",
	"if [ $S -ne 0 ]; then",
	"  printf '\\033[1;31m✗ Setup failed (exit %s)\\033[0m\\n' \"$S\"",
	"  printf '%s' \"$S\" > '/tmp/dev3-T-setup-exit'",
	"  exec '/bin/zsh'",
	"fi",
	"printf '\\033[1;32m✓ Setup done\\033[0m\\n'",
	"exec '/bin/zsh' '/tmp/dev3-T-cmd.sh'",
].join("\n") + "\n";

const STARTUP_WRAPPER_TMUX_PARALLEL = [
	"#!/bin/bash",
	"tmux split-window -v -b -c \"/w/t\" \"'/bin/zsh' '/tmp/dev3-T-cmd.sh'\"",
	"'/bin/zsh' -x '/tmp/dev3-T-setup.sh'",
	"S=$?",
	"if [ $S -ne 0 ]; then",
	"  printf '\\033[1;31m✗ Setup failed (exit %s)\\033[0m\\n' \"$S\"",
	"  printf '%s' \"$S\" > '/tmp/dev3-T-setup-exit'",
	"  exec '/bin/zsh'",
	"fi",
	"printf '\\033[1;32m✓ Setup done\\033[0m\\n'",
	"printf '\\033[2mClosing in 15s — press any key to close now\\033[0m\\n'",
	"if [ -n \"$ZSH_VERSION\" ]; then read -t 15 -k 1 -s; else read -t 15 -n 1 -s; fi",
	"exit 0",
].join("\n") + "\n";

const STARTUP_WRAPPER_TMUX_BLOCKING = [
	"#!/bin/bash",
	"'/bin/zsh' -x '/tmp/dev3-T-setup.sh'",
	"S=$?",
	"if [ $S -ne 0 ]; then",
	"  printf '\\033[1;31m✗ Setup failed (exit %s)\\033[0m\\n' \"$S\"",
	"  printf '%s' \"$S\" > '/tmp/dev3-T-setup-exit'",
	"  exec '/bin/zsh'",
	"fi",
	"tmux split-window -v -b -c \"/w/t\" \"'/bin/zsh' '/tmp/dev3-T-cmd.sh'\"",
	"printf '\\033[1;32m✓ Setup done\\033[0m\\n'",
	"printf '\\033[2mClosing in 15s — press any key to close now\\033[0m\\n'",
	"if [ -n \"$ZSH_VERSION\" ]; then read -t 15 -k 1 -s; else read -t 15 -n 1 -s; fi",
	"exit 0",
].join("\n") + "\n";

const startupWrapper = (overrides: { nativeBackend: boolean; launchMode: "parallel" | "blocking" }) =>
	buildSetupStartupWrapper({
		setupPath: SETUP_PATH,
		cmdPath: CMD_PATH,
		worktreePath: WORKTREE,
		shellPath: SHELL,
		setupExitPath: SETUP_EXIT_PATH,
		...overrides,
	});

describe("POSIX run wrapper (buildCmdScript)", () => {
	const originalShell = process.env.SHELL;
	afterEach(() => {
		if (originalShell === undefined) delete process.env.SHELL;
		else process.env.SHELL = originalShell;
	});

	it("renders the keep-shell flavour byte-identically", () => {
		expect(
			buildCmdScript("claude 'Fix bug'", { FOO: "bar baz" }, { keepShell: true, shellPath: SHELL, paneTitle: "Agent" }),
		).toBe(RUN_WRAPPER_KEEP_SHELL);
	});

	it("renders the exit-on-success flavour byte-identically", () => {
		expect(
			buildCmdScript("claude 'Fix bug'", { FOO: "bar baz" }, { keepShell: false, shellPath: SHELL, onExitCommand: "echo bye" }),
		).toBe(RUN_WRAPPER_NO_KEEP_SHELL);
	});

	it("falls back to $SHELL when no shell path is given", () => {
		process.env.SHELL = "/bin/bash";
		expect(buildCmdScript("claude")).toBe(RUN_WRAPPER_DEFAULT_SHELL);
	});
});

describe("POSIX agent-not-found retry wrapper", () => {
	it("renders byte-identically", () => {
		expect(
			buildAgentRetryWrapper({
				binaryName: "claude",
				installCmd: "npm i -g claude",
				originalCmdPath: ORIGINAL_CMD_PATH,
				shellPath: SHELL,
			}),
		).toBe(AGENT_RETRY_WRAPPER);
	});
});

describe("POSIX setup/startup wrapper", () => {
	it("renders the native flavour byte-identically", () => {
		expect(startupWrapper({ nativeBackend: true, launchMode: "parallel" })).toBe(STARTUP_WRAPPER_NATIVE);
	});

	it("renders the tmux parallel flavour byte-identically", () => {
		expect(startupWrapper({ nativeBackend: false, launchMode: "parallel" })).toBe(STARTUP_WRAPPER_TMUX_PARALLEL);
	});

	it("renders the tmux blocking flavour byte-identically", () => {
		expect(startupWrapper({ nativeBackend: false, launchMode: "blocking" })).toBe(STARTUP_WRAPPER_TMUX_BLOCKING);
	});
});

describe("POSIX launch primitives", () => {
	it("renders env exports and unsets", () => {
		expect(buildEnvExports({ FOO: "bar baz", GONE: ENV_UNSET })).toEqual([
			"export FOO='bar baz'",
			"unset GONE",
		]);
	});

	it("renders the script runner with and without tracing", () => {
		expect(buildScriptRunnerCommand("/tmp/s.sh", { shellPath: SHELL })).toBe("'/bin/zsh' '/tmp/s.sh'");
		expect(buildScriptRunnerCommand("/tmp/s.sh", { shellPath: SHELL, trace: true })).toBe("'/bin/zsh' -x '/tmp/s.sh'");
	});

	it("renders the shell-portable read-key snippet", () => {
		expect(portableReadKey()).toBe('if [ -n "$ZSH_VERSION" ]; then read -k 1 -s; else read -n 1 -s; fi');
		expect(portableReadKey({ timeoutSeconds: 15 })).toBe(
			'if [ -n "$ZSH_VERSION" ]; then read -t 15 -k 1 -s; else read -t 15 -n 1 -s; fi',
		);
	});
});
