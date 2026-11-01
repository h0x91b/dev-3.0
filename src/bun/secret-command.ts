import { SECRET_RUN_MS, type SecretRequest } from "../shared/secret-request";
import { spawn } from "./spawn";

export async function runSecretCommand(request: SecretRequest, secret: string, signal: AbortSignal): Promise<number> {
	if (signal.aborted) throw new Error("Secret command cancelled.");
	const child = spawn(request.command, {
		cwd: request.cwd,
		env: { [request.env]: secret },
		stdin: "ignore", stdout: "ignore", stderr: "ignore",
		signal, timeout: SECRET_RUN_MS, killSignal: "SIGKILL",
	});
	secret = "";
	return await child.exited;
}
