import { randomUUID } from "node:crypto";
import { SECRET_MAX_LENGTH, SECRET_WAIT_MS, SECRET_RUN_MS, type SecretRequest, type SecretResult } from "../shared/secret-request";

type Run = (request: SecretRequest, secret: string, signal: AbortSignal) => Promise<number>;
type Push = (name: "secretRequested" | "secretRequestResolved", payload: SecretRequest | { requestId: string }) => void;
type Pending = {
	request: SecretRequest;
	controller: AbortController;
	finish: (result: SecretResult) => void;
	running: boolean;
	timer: ReturnType<typeof setTimeout>;
};

export class SecretRequests {
	private pending = new Map<string, Pending>();

	constructor(private run: Run, private push: Push) {}

	list(): SecretRequest[] {
		return [...this.pending.values()].filter((entry) => !entry.running).map(({ request }) => structuredClone(request));
	}

	request(input: Omit<SecretRequest, "requestId" | "expiresAt">, signal?: AbortSignal): Promise<SecretResult> {
		if (signal?.aborted) return Promise.resolve({ status: "cancelled" });
		if (this.pending.size >= 16 || [...this.pending.values()].some((entry) => entry.request.taskId === input.taskId)) {
			throw new Error("A secret request is already pending for this task, or the request limit was reached.");
		}
		const request: SecretRequest = { ...structuredClone(input), requestId: randomUUID(), expiresAt: Date.now() + SECRET_WAIT_MS };
		return new Promise((resolve) => {
			const abort = () => entry.finish({ status: "cancelled" });
			const timer = setTimeout(() => entry.finish({ status: "expired" }), SECRET_WAIT_MS);
			const entry: Pending = {
				request, controller: new AbortController(), running: false, timer,
				finish: (result) => {
					if (!this.pending.delete(request.requestId)) return;
					clearTimeout(entry.timer);
					signal?.removeEventListener("abort", abort);
					entry.controller.abort();
					try { this.push("secretRequestResolved", { requestId: request.requestId }); } catch { /* A disconnected UI cannot retain a request. */ }
					resolve(result);
				},
			};
			this.pending.set(request.requestId, entry);
			signal?.addEventListener("abort", abort, { once: true });
			try { this.push("secretRequested", structuredClone(request)); }
			catch { entry.finish({ status: "failed" }); }
		});
	}

	respond(requestId: string, secret?: string): boolean {
		const entry = this.pending.get(requestId);
		if (!entry || entry.running) return false;
		if (Date.now() >= entry.request.expiresAt) {
			entry.finish({ status: "expired" });
			return false;
		}
		if (secret === undefined) {
			entry.finish({ status: "declined" });
			return true;
		}
		if (typeof secret !== "string" || secret.length === 0 || secret.length > SECRET_MAX_LENGTH || secret.includes("\0")) {
			throw new Error("Enter a non-empty secret without NUL characters, up to 16 KiB.");
		}
		entry.running = true;
		clearTimeout(entry.timer);
		entry.timer = setTimeout(() => entry.finish({ status: "expired" }), SECRET_RUN_MS);
		try { this.push("secretRequestResolved", { requestId }); } catch { /* Execution is owned by the CLI connection. */ }
		// Never retain the value in pending state, a result, or an error message.
		void Promise.resolve().then(() => this.run(entry.request, secret, entry.controller.signal))
			.then((exitCode) => entry.finish({ status: "finished", exitCode }))
			.catch(() => entry.finish({ status: "failed" }));
		return true;
	}
}
