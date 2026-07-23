/**
 * Isolated in-memory transport for the stream-resync spike (see ./README.md).
 *
 * One FakeLink per client. It carries host→client frames and injects faults
 * deterministically: drop, duplicate, hold (reorder), disconnect, reconnect.
 * No sockets, timers, or randomness — every fault is scripted by the test.
 */

import type { DeltaFrame, HostFrame, SnapshotFrame } from "./protocol";

export type LinkFault = "pass" | "drop" | "duplicate" | "hold";

export class FakeLink {
	connected = true;
	private readonly plan: LinkFault[] = [];
	private readonly held: DeltaFrame[] = [];

	constructor(private readonly deliver: (frame: HostFrame) => void) {}

	/** Per-delta fault instructions consumed in order; unscripted deltas pass. */
	schedule(...faults: LinkFault[]): void {
		this.plan.push(...faults);
	}

	sendDelta(frame: DeltaFrame): void {
		if (!this.connected) return; // lost while disconnected
		const fault = this.plan.shift() ?? "pass";
		switch (fault) {
			case "drop":
				return;
			case "duplicate":
				this.deliver(frame);
				this.deliver(frame);
				return;
			case "hold":
				this.held.push(frame);
				return;
			default:
				this.deliver(frame);
		}
	}

	/** Deliver held deltas now, producing out-of-order arrival. */
	flushHeld(): void {
		const pending = this.held.splice(0);
		for (const frame of pending) if (this.connected) this.deliver(frame);
	}

	/** Snapshots are the resync escape hatch; they are delivered reliably. */
	deliverSnapshot(frame: SnapshotFrame): void {
		if (this.connected) this.deliver(frame);
	}

	disconnect(): void {
		this.connected = false;
	}

	reconnect(): void {
		this.connected = true;
	}
}
