/**
 * The native adapter must satisfy the backend-neutral ParityRunner shape without
 * importing it in production code (CUT-001). This test-only assignment fails the
 * type-check if the two ever drift, proving conformance structurally.
 */
import { describe, expect, it } from "vitest";
import type { ParityRunner, ReconnectFactory } from "../../terminal-parity/runner";
import { NativeSingleViewAdapter } from "../adapter";

describe("native adapter ParityRunner conformance", () => {
	it("structurally implements ParityRunner + ReconnectFactory", () => {
		const adapter = new NativeSingleViewAdapter({ owner: false });
		const runner: ParityRunner = adapter;
		const factory: ReconnectFactory = adapter;
		expect(runner.backend).toBe("native");
		expect(typeof factory.reconnect).toBe("function");
	});
});
