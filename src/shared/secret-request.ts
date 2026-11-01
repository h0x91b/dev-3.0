export const SECRET_WAIT_MS = 10 * 60_000;
export const SECRET_RUN_MS = 5 * 60_000;
export const SECRET_MAX_LENGTH = 16_384;

export interface SecretRequest {
	requestId: string;
	projectId: string;
	taskId: string;
	taskTitle: string;
	env: string;
	command: string[];
	cwd: string;
	runStartedAt: string | null;
	expiresAt: number;
}

export type SecretResult =
	| { status: "finished"; exitCode: number }
	| { status: "declined" | "expired" | "cancelled" | "failed" };

export function validateSecretCommand(env: unknown, command: unknown): asserts command is string[] {
	if (typeof env !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(env)) {
		throw new Error("Supply one valid environment variable name with --env NAME.");
	}
	if (!Array.isArray(command) || command.length === 0 || command.length > 128
		|| command.some((arg) => typeof arg !== "string" || arg.includes("\0"))
		|| !command[0] || JSON.stringify(command).length > 32_768) {
		throw new Error("Supply a command after -- (up to 128 arguments and 32 KiB).");
	}
}

export function secretTransportAllowed(location: { protocol: string; hostname: string }): boolean {
	return location.protocol === "https:" || location.protocol === "views:"
		|| ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
}
