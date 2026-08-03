/**
 * A "durable" renderer diagnostic has to survive the production log level (seq 1407).
 *
 * The terminal-dispose markers exist so a teardown that never returned leaves evidence
 * a restart cannot erase. The renderer's console is not that evidence — it dies with
 * the window — so the markers go through `logRendererDiagnostic`, which forwards to
 * this logger. But prod/staging/canary run at a minimum of `info`, so a `debug` line is
 * dropped before it is ever appended and the marker would be silently non-durable.
 *
 * This half pins the level policy. The other half — that TerminalView actually asks for
 * a level which survives it — is asserted behaviourally in TerminalView.test.tsx.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createLogger, getMinLevel, resolveLogLevel, setMinLevel } from "../logger";

const original = getMinLevel();

afterEach(() => {
	setMinLevel(original);
	vi.restoreAllMocks();
});

/** What the process would actually write at the given minimum. */
function writesAt(minimum: "debug" | "info" | "warn" | "error", emit: () => void): string {
	setMinLevel(minimum);
	const written: string[] = [];
	const capture = (...args: unknown[]) => void written.push(args.map(String).join(" "));
	// warn goes to console.warn, info/debug to console.log — capture both, since the
	// durable set spans two levels.
	const spies = [
		vi.spyOn(console, "log").mockImplementation(capture),
		vi.spyOn(console, "warn").mockImplementation(capture),
	];
	try {
		emit();
	} finally {
		for (const spy of spies) spy.mockRestore();
	}
	return written.join("");
}

describe("terminal-dispose marker durability", () => {
	it("defaults to info outside dev, which is the constraint the markers live under", () => {
		expect(resolveLogLevel({ DEV3_CHANNEL: "prod" })).toBe("info");
		expect(resolveLogLevel({ DEV3_CHANNEL: "canary" })).toBe("info");
		expect(resolveLogLevel({ DEV3_CHANNEL: "dev" })).toBe("debug");
	});

	it("persists both cleanup markers and the budget overrun at the production minimum", () => {
		const log = createLogger("renderer");
		const out = writesAt("info", () => {
			log.info("[terminal-dispose] cleanup started");
			log.info("[terminal-dispose] cleanup finished", { disposeMs: 12 });
			log.warn("[terminal-dispose] cleanup exceeded its budget", { disposeMs: 900, budgetMs: 50 });
		});
		expect(out).toContain("[terminal-dispose] cleanup started");
		expect(out).toContain("[terminal-dispose] cleanup finished");
		expect(out).toContain("cleanup exceeded its budget");
	});

	it("would have dropped the markers at debug — which is why they are not debug", () => {
		const log = createLogger("renderer");
		const out = writesAt("info", () => log.debug("[terminal-dispose] cleanup started"));
		expect(out).not.toContain("cleanup started");
	});


});
