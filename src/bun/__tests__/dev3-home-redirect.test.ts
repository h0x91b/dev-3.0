import { describe, expect, it } from "vitest";
import { resolveDev3Home } from "../../shared/dev3-home";

describe("resolveDev3Home", () => {
	it("honours DEV3_HOME over the user home", () => {
		expect(resolveDev3Home({ DEV3_HOME: "/scratch/qa/.dev3.0", HOME: "/Users/real" }))
			.toBe("/scratch/qa/.dev3.0");
	});

	it("falls back to ~/.dev3.0 when the override is absent or blank", () => {
		expect(resolveDev3Home({ HOME: "/Users/real" })).toBe("/Users/real/.dev3.0");
		expect(resolveDev3Home({ DEV3_HOME: "   ", HOME: "/Users/real" })).toBe("/Users/real/.dev3.0");
	});

	it("normalises an override the way every concatenated path expects", () => {
		// Backslashes and a trailing slash would break the `startsWith` prefix checks
		// that decide whether a path is dev3-managed.
		expect(resolveDev3Home({ DEV3_HOME: "C:\\scratch\\qa\\.dev3.0\\", HOME: "/Users/real" }))
			.toBe("C:/scratch/qa/.dev3.0");
	});

	it("keeps the native-terminal path families on the same root as the app", async () => {
		// The half-redirect this converged: these modules honoured DEV3_HOME while the
		// app's own DEV3_HOME did not, so a redirected instance was half-scoped.
		const previous = process.env.DEV3_HOME;
		process.env.DEV3_HOME = "/scratch/qa/.dev3.0";
		try {
			const registry = await import("../native-terminal-registry/paths");
			const multipane = await import("../native-terminal-multipane/paths");
			for (const key of ["DEV3_NATIVE_SESSIONS_DIR", "DEV3_NATIVE_MULTIPANE_DIR"]) delete process.env[key];

			expect(registry.sessionsRootDir()).toBe("/scratch/qa/.dev3.0/native-sessions");
			expect(registry.detachedHostCwd()).toBe("/scratch/qa/.dev3.0");
			expect(multipane.multipaneRootDir()).toBe("/scratch/qa/.dev3.0/native-multipane");
		} finally {
			if (previous === undefined) delete process.env.DEV3_HOME;
			else process.env.DEV3_HOME = previous;
		}
	});
});
