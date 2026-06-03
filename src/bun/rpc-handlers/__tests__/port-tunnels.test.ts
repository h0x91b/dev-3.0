import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { portTunnelHandlers } from "../port-tunnels";

describe("getSshForwardCommand", () => {
	const originalEnv = process.env.SSH_CONNECTION;
	afterEach(() => {
		if (originalEnv === undefined) delete process.env.SSH_CONNECTION;
		else process.env.SSH_CONNECTION = originalEnv;
	});

	it("builds a single-port command with the SSH_CONNECTION host", () => {
		process.env.SSH_CONNECTION = "1.2.3.4 54321 10.0.0.5 22";
		const { command, hostGuess } = portTunnelHandlers.getSshForwardCommand({ ports: [3000] });
		expect(hostGuess).toBe("10.0.0.5");
		expect(command).toMatch(/^ssh -L 3000:localhost:3000 \S+@10\.0\.0\.5$/);
	});

	it("forwards multiple ports in a single command", () => {
		process.env.SSH_CONNECTION = "1.2.3.4 54321 10.0.0.5 22";
		const { command } = portTunnelHandlers.getSshForwardCommand({ ports: [3000, 5173, 8080] });
		expect(command).toContain("-L 3000:localhost:3000");
		expect(command).toContain("-L 5173:localhost:5173");
		expect(command).toContain("-L 8080:localhost:8080");
	});

	it("falls back to <host> placeholder when SSH_CONNECTION is missing", () => {
		delete process.env.SSH_CONNECTION;
		const { command, hostGuess } = portTunnelHandlers.getSshForwardCommand({ ports: [3000] });
		expect(hostGuess).toBeNull();
		expect(command).toContain("@<host>");
	});

	it("falls back to <host> when SSH_CONNECTION is malformed", () => {
		process.env.SSH_CONNECTION = "garbage";
		const { hostGuess } = portTunnelHandlers.getSshForwardCommand({ ports: [3000] });
		expect(hostGuess).toBeNull();
	});
});

describe("portTunnelHandlers — surface", () => {
	beforeEach(() => {
		// Each handler is a thin wrapper; we only assert they exist and are callable.
	});

	it("exports the expected RPC methods", () => {
		expect(typeof portTunnelHandlers.exposePort).toBe("function");
		expect(typeof portTunnelHandlers.exposePortsShared).toBe("function");
		expect(typeof portTunnelHandlers.unexposePort).toBe("function");
		expect(typeof portTunnelHandlers.unexposeShared).toBe("function");
		expect(typeof portTunnelHandlers.listExposedPorts).toBe("function");
		expect(typeof portTunnelHandlers.getSshForwardCommand).toBe("function");
	});
});
