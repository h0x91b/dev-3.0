import { describe, expect, it } from "vitest";
import { agentAlternativeInstallCommand, agentInstallCommand, agentNotInstalledMessage, isAgentNotInstalledError } from "../../shared/agent-install";
import { DEFAULT_AGENTS } from "../../shared/types";

const omp = DEFAULT_AGENTS.find((a) => a.id === "builtin-omp")!;
const pi = DEFAULT_AGENTS.find((a) => a.id === "builtin-pi")!;

describe("agentInstallCommand", () => {
	it("gives omp its upstream installers, POSIX on macOS/Linux and PowerShell on Windows", () => {
		expect(agentInstallCommand(omp, "darwin")).toBe("curl -fsSL https://omp.sh/install | sh");
		expect(agentInstallCommand(omp, "linux")).toBe("curl -fsSL https://omp.sh/install | sh");
		expect(agentInstallCommand(omp, "win32")).toBe("irm https://omp.sh/install.ps1 | iex");
	});

	it("gives plain pi its upstream installers, POSIX and Windows", () => {
		expect(agentInstallCommand(pi, "darwin")).toBe("curl -fsSL https://pi.dev/install.sh | sh");
		expect(agentInstallCommand(pi, "linux")).toBe("curl -fsSL https://pi.dev/install.sh | sh");
		expect(agentInstallCommand(pi, "win32")).toBe('powershell -c "irm https://pi.dev/install.ps1 | iex"');
	});

	it("never overrides a command the user edited", () => {
		expect(agentInstallCommand({ ...omp, installCommand: "bun install -g @oh-my-pi/pi-coding-agent" }, "win32"))
			.toBe("bun install -g @oh-my-pi/pi-coding-agent");
	});
});

describe("agentAlternativeInstallCommand", () => {
	it("offers pi's Homebrew formula where Homebrew runs", () => {
		expect(agentAlternativeInstallCommand(pi, "darwin")).toBe("brew install pi-coding-agent");
		expect(agentAlternativeInstallCommand(pi, "linux")).toBe("brew install pi-coding-agent");
	});

	it("offers nothing on Windows, for agents without a verified alternative, or when it already is the install command", () => {
		expect(agentAlternativeInstallCommand(pi, "win32"), "windows").toBeUndefined();
		expect(agentAlternativeInstallCommand(omp, "darwin"), "no alternative").toBeUndefined();
		expect(agentAlternativeInstallCommand({ ...pi, installCommand: "brew install pi-coding-agent" }, "darwin"), "user's own command").toBeUndefined();
	});

});

describe("agent-not-installed message", () => {
	it("names the alternative install after the upstream one, and carries the marker the renderer keys its re-check on", () => {
		expect(agentNotInstalledMessage({ agentName: "Pi", binaryName: "pi", installCommand: "curl x | sh", alternativeInstallCommand: "brew install pi-coding-agent" }))
			.toContain("Install it with: curl x | sh (or: brew install pi-coding-agent)");

		const message = agentNotInstalledMessage({ agentName: "Oh My Pi", binaryName: "omp", installCommand: "x" });
		expect(isAgentNotInstalledError(`Error: ${message}`)).toBe(true);
		expect(isAgentNotInstalledError("Error: tmux failed")).toBe(false);
	});
});
