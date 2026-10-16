import { describe, expect, it } from "vitest";
import { agentInstallCommand, agentNotInstalledMessage, isAgentNotInstalledError } from "../../shared/agent-install";
import { DEFAULT_AGENTS } from "../../shared/types";

const omp = DEFAULT_AGENTS.find((a) => a.id === "builtin-omp")!;
const pi = DEFAULT_AGENTS.find((a) => a.id === "builtin-pi")!;

describe("agentInstallCommand", () => {
	it("keeps omp's upstream POSIX installer on macOS and Linux", () => {
		expect(agentInstallCommand(omp, "darwin")).toBe("curl -fsSL https://omp.sh/install | sh");
		expect(agentInstallCommand(omp, "linux")).toBe("curl -fsSL https://omp.sh/install | sh");
	});

	it("gives Windows omp's upstream PowerShell installer", () => {
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

describe("agent-not-installed message", () => {
	it("carries the marker the renderer keys its re-check on", () => {
		const message = agentNotInstalledMessage({ agentName: "Oh My Pi", binaryName: "omp", installCommand: "x" });
		expect(isAgentNotInstalledError(`Error: ${message}`)).toBe(true);
		expect(isAgentNotInstalledError("Error: tmux failed")).toBe(false);
	});
});
