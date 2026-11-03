import { strict as assert } from "node:assert";
import { runSecretCommand } from "../secret-command";
import type { SecretRequest } from "../../shared/secret-request";

const request: SecretRequest = {
	requestId: "synthetic", projectId: "synthetic", taskId: "synthetic", taskTitle: "Synthetic secret smoke",
	env: "DEV3_SYNTHETIC_SECRET", cwd: process.cwd(), expiresAt: Date.now() + 60_000, runStartedAt: null,
	command: [process.execPath, "-e", `
		const value = process.env.DEV3_SYNTHETIC_SECRET;
		console.log(value);
		console.error(Buffer.from(value || '').toString('base64'));
		process.exit(value === 'synthetic-private-value' ? 0 : 1);
	`],
};
assert.equal(await runSecretCommand(request, "synthetic-private-value", new AbortController().signal), 0);
assert.equal(process.env.DEV3_SYNTHETIC_SECRET, undefined);
const controller = new AbortController();
const running = runSecretCommand({ ...request, command: [process.execPath, "-e", "setInterval(() => {}, 1000)"] }, "synthetic-private-value", controller.signal);
controller.abort();
await running.catch(() => {});
console.log("Secret command runtime smoke passed; child output was discarded.");
