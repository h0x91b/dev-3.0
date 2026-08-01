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

	/**
	 * Drop a client. The lease is deliberately NOT handed on when the writer
	 * leaves — write authority never moves between processes implicitly — but the
	 * survivors are returned so the caller can tell them the slot is now free.
	 * Without that they keep believing someone else is typing and never claim it,
	 * which strands them read-only against a host that has no writer at all.
	 */
	detach(client: Client): Client[] {
		const wasWriter = this.writer === client;
		this.clients.delete(client);
		if (!wasWriter) return [];
		this.writer = null;
		return [...this.clients];
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

	/** The client holding the lease, so the host can report WHO owns it. */
	writerClient(): Client | null {
		return this.writer;
	}
}
