import os from "node:os";
import type { ExposedPort } from "../../shared/types";

async function exposePort({ taskId, port }: { taskId: string; port: number }): Promise<ExposedPort> {
	const { exposeTaskPort } = await import("../port-tunnels");
	return exposeTaskPort(taskId, port);
}

async function exposePortsShared({ taskId, ports }: { taskId: string; ports: number[] }): Promise<ExposedPort> {
	const { exposeTaskPortsShared } = await import("../port-tunnels");
	const { getServerPort } = await import("../remote-access-server");
	return exposeTaskPortsShared(taskId, ports, getServerPort());
}

async function unexposePort({ taskId, port }: { taskId: string; port: number }): Promise<void> {
	const { unexposeTaskPort } = await import("../port-tunnels");
	unexposeTaskPort(taskId, port);
}

async function unexposeShared({ taskId }: { taskId: string }): Promise<void> {
	const { unexposeShared: doUnexpose } = await import("../port-tunnels");
	doUnexpose(taskId);
}

async function listExposedPorts({ taskId }: { taskId?: string } = {}): Promise<ExposedPort[]> {
	const { getExposedPorts } = await import("../port-tunnels");
	return getExposedPorts(taskId);
}

/**
 * Build a ready-to-paste `ssh -L` command that forwards the given ports.
 * Host is inferred from the `SSH_CONNECTION` env var (set by sshd when the
 * server is reached over SSH); falls back to the `<host>` placeholder so the
 * user just edits in their own server. User name comes from the current
 * process owner — the same user that would be authenticating.
 */
function getSshForwardCommand({ ports }: { ports: number[] }): { command: string; hostGuess: string | null } {
	// SSH_CONNECTION format: "<client_ip> <client_port> <server_ip> <server_port>"
	const sshConn = process.env.SSH_CONNECTION;
	let hostGuess: string | null = null;
	if (sshConn) {
		const parts = sshConn.trim().split(/\s+/);
		if (parts.length === 4 && parts[2]) hostGuess = parts[2];
	}
	const username = (() => {
		try { return os.userInfo().username; } catch { return ""; }
	})();
	const host = hostGuess ?? "<host>";
	const userAt = username ? `${username}@${host}` : host;
	const flags = ports.map((p) => `-L ${p}:localhost:${p}`).join(" ");
	const command = `ssh ${flags} ${userAt}`;
	return { command, hostGuess };
}

export const portTunnelHandlers = {
	exposePort,
	exposePortsShared,
	unexposePort,
	unexposeShared,
	listExposedPorts,
	getSshForwardCommand,
};
