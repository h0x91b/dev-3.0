/**
 * Install guidance for agent harnesses, per execution-host platform.
 *
 * Every command here is copied from the harness's own upstream README — never
 * guessed. Only overrides that were checked against upstream belong in the table;
 * an agent without one keeps its single `installCommand`.
 */

const OMP_POSIX_INSTALL = "curl -fsSL https://omp.sh/install | sh";
const PI_POSIX_INSTALL = "curl -fsSL https://pi.dev/install.sh | sh";

/** Windows commands keyed by builtin agent id, valid only while the agent still
 *  carries the stock POSIX command (a user-edited command is theirs and wins). */
const WINDOWS_INSTALL_OVERRIDES: Record<string, { posix: string; windows: string }> = {
	// can1357/oh-my-pi README → "Windows (PowerShell)".
	"builtin-omp": { posix: OMP_POSIX_INSTALL, windows: "irm https://omp.sh/install.ps1 | iex" },
	// earendil-works/pi README → "Getting started", the Windows line verbatim.
	"builtin-pi": { posix: PI_POSIX_INSTALL, windows: 'powershell -c "irm https://pi.dev/install.ps1 | iex"' },
};

export function agentInstallCommand(
	agent: { id: string; installCommand?: string },
	platform: string,
): string | undefined {
	const override = WINDOWS_INSTALL_OVERRIDES[agent.id];
	if (platform === "win32" && override && agent.installCommand === override.posix) return override.windows;
	return agent.installCommand;
}

/** Substring in every launch refusal for a missing harness binary. The error
 *  crosses RPC as a plain string; the renderer keys its refresh on this. */
export const AGENT_NOT_INSTALLED_MARKER = "is not installed on the machine running dev3";

export function agentNotInstalledMessage(opts: { agentName: string; binaryName: string; installCommand?: string }): string {
	const install = opts.installCommand ? ` Install it with: ${opts.installCommand}` : "";
	return `${opts.agentName} ${AGENT_NOT_INSTALLED_MARKER} ("${opts.binaryName}" was not found on PATH).${install} Then launch again.`;
}

export function isAgentNotInstalledError(errorText: string | null | undefined): boolean {
	return !!errorText?.includes(AGENT_NOT_INSTALLED_MARKER);
}
