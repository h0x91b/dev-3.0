/**
 * An in-memory coordinator world for NativeTerminalBackend tests.
 *
 * Wraps the existing FakeRegistry so the coordinator gets a fully-functional
 * fake without spawning real processes. Exposes the product-test helpers
 * (killViewProcess, geometry) the conformance suite needs.
 */

import { NATIVE_MULTIPANE_DIR_ENV } from "../../native-terminal-multipane/paths";
import { createFakeRegistry, type FakeRegistry } from "../../native-terminal-multipane/__tests__/fake-panes";
import type { CoordinatorDeps } from "../../native-terminal-multipane/coordinator";

export class FakeCoordinatorWorld {
	readonly registry: FakeRegistry;

	constructor() {
		// Use a fresh temp dir override so coordinator records don't collide.
		const tmp = `/tmp/dev3-fake-coordinator-${Math.random().toString(36).slice(2)}`;
		process.env[NATIVE_MULTIPANE_DIR_ENV] = tmp;
		this.registry = createFakeRegistry();
	}

	cleanup(): void {
		delete process.env[NATIVE_MULTIPANE_DIR_ENV];
	}

	deps(): Partial<CoordinatorDeps> {
		return this.registry;
	}

	/**
	 * Kill the process backing a view (pane id like "pane-1") so the backend
	 * reports the session as gone — mirrors what the conformance suite expects.
	 * The coordinator id must be provided because pane session ids are derived
	 * from it.
	 */
	killViewProcess(coordinatorId: string, paneId: string): void {
		const sessionId = `${coordinatorId}-${paneId}`;
		this.registry.kill(sessionId);
	}

	/** Current geometry of the first pane in a coordinator. */
	geometry(coordinatorId: string): { cols: number; rows: number } {
		// Find the first pane whose session id starts with the coordinator id.
		for (const [sessionId, pane] of this.registry.panes) {
			if (sessionId.startsWith(`${coordinatorId}-`)) {
				return { cols: pane.record.cols, rows: pane.record.rows };
			}
		}
		return { cols: 80, rows: 24 };
	}
}
