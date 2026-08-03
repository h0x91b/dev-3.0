/** Host-local writer lease for one native terminal session. */
export type ClientRole = "writer" | "observer";
/**
 * `claim` takes a VACANT slot and never displaces anyone — that is what keeps
 * ordinary attachment non-stealing. `takeover` is the explicit user gesture and
 * is the only action that moves a live lease.
 */
export type WriterAction = "claim" | "release" | "takeover";
export type WriterConflict = "not-attached" | "not-writer" | "writer-active";
export type WriterRequestResult =
	| { ok: true; role: ClientRole; writerAttached: boolean; generation: number }
	| { ok: false; reason: WriterConflict; role: ClientRole | null; writerAttached: boolean; generation: number };

/**
 * Tracks authenticated clients by connection identity. The first live client is
 * the writer; later clients observe until the writer explicitly releases or
 * disconnects and one observer claims the vacant slot.
 *
 * Every ACTUAL move of the writer pointer (`null→A`, `A→null`, `A→B`) bumps a
 * monotonic {@link generation}. Idempotent requests — the current writer claiming or
 * taking over again — deliberately do NOT bump it, so a client can tell "the lease
 * I know about" from "a lease that has moved since" and refuse to act on stale
 * belief. It is host-local and ephemeral: a fresh host starts at 0.
 */
export class WriterOwnership<Client> {
	private readonly clients = new Set<Client>();
	private writer: Client | null = null;
	private generation = 0;

	/** Monotonic count of real pointer transitions on this host. */
	writerGeneration(): number {
		return this.generation;
	}

	/** Move the pointer and count it. The ONLY place `writer` is assigned. */
	private transition(next: Client | null): void {
		if (this.writer === next) return; // idempotent: not a transition, must not count
		this.writer = next;
		this.generation++;
	}

	attach(client: Client): ClientRole {
		if (this.clients.has(client)) return this.roleOf(client) ?? "observer";
		const isFirstClient = this.clients.size === 0;
		this.clients.add(client);
		if (isFirstClient) this.transition(client);
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
		this.transition(null);
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
		if (!role) {
			return { ok: false, reason: "not-attached", role: null, writerAttached: this.hasWriter(), generation: this.generation };
		}
		if (action === "release") {
			if (this.writer !== client) {
				return { ok: false, reason: "not-writer", role, writerAttached: this.hasWriter(), generation: this.generation };
			}
			this.transition(null);
			return { ok: true, role: "observer", writerAttached: false, generation: this.generation };
		}
		// Idempotent: the current writer asking again succeeds without moving anything,
		// which is what lets an explicit gesture always be SENT without fear — a client
		// whose cached role is stale cannot tell whether it still owns the lease.
		if (this.writer === client) {
			return { ok: true, role: "writer", writerAttached: true, generation: this.generation };
		}
		if (this.writer !== null && action === "claim") {
			return { ok: false, reason: "writer-active", role, writerAttached: true, generation: this.generation };
		}
		// One synchronous swap on the host's single event loop: there is never a turn with
		// two writers. Who was displaced is NOT reported — the host tells every non-winner
		// in one broadcast, and a second per-client channel would duplicate the transition.
		this.transition(client);
		return { ok: true, role: "writer", writerAttached: true, generation: this.generation };
	}

	hasWriter(): boolean {
		return this.writer !== null;
	}

	/** The client holding the lease, so the host can report WHO owns it. */
	writerClient(): Client | null {
		return this.writer;
	}
}
