/** Host-local writer lease for one native terminal session. */
export type ClientRole = "writer" | "observer";
export type WriterAction = "claim" | "release";
export type WriterConflict = "not-attached" | "not-writer" | "writer-active";
export type WriterRequestResult =
	| { ok: true; role: ClientRole; writerAttached: boolean }
	| { ok: false; reason: WriterConflict; role: ClientRole | null; writerAttached: boolean };

/**
 * Tracks authenticated clients by connection identity. The first live client is
 * the writer; later clients observe until the writer explicitly releases or
 * disconnects and one observer claims the vacant slot.
 */
export class WriterOwnership<Client> {
	private readonly clients = new Set<Client>();
	private writer: Client | null = null;

	attach(client: Client): ClientRole {
		if (this.clients.has(client)) return this.roleOf(client) ?? "observer";
		const isFirstClient = this.clients.size === 0;
		this.clients.add(client);
		if (isFirstClient) this.writer = client;
		return this.roleOf(client) ?? "observer";
	}

	detach(client: Client): void {
		if (this.writer === client) this.writer = null;
		this.clients.delete(client);
	}

	roleOf(client: Client): ClientRole | null {
		if (!this.clients.has(client)) return null;
		return this.writer === client ? "writer" : "observer";
	}

	canMutatePty(client: Client): boolean {
		return this.writer === client;
	}

	request(client: Client, action: WriterAction): WriterRequestResult {
		const role = this.roleOf(client);
		if (!role) return { ok: false, reason: "not-attached", role: null, writerAttached: this.hasWriter() };
		if (action === "release") {
			if (this.writer !== client) {
				return { ok: false, reason: "not-writer", role, writerAttached: this.hasWriter() };
			}
			this.writer = null;
			return { ok: true, role: "observer", writerAttached: false };
		}
		if (this.writer === client) return { ok: true, role: "writer", writerAttached: true };
		if (this.writer !== null) {
			return { ok: false, reason: "writer-active", role, writerAttached: true };
		}
		this.writer = client;
		return { ok: true, role: "writer", writerAttached: true };
	}

	hasWriter(): boolean {
		return this.writer !== null;
	}
}
