import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Both entries boot the whole app, so they cannot be imported in a test; their
// source is the cheapest evidence. `dev3 remote` runs headless-entry, not index.ts.
const source = (file: string) => readFileSync(join(import.meta.dirname, "..", file), "utf8");

describe("scheduled-launch scheduler wiring", () => {
	it.each(["index.ts", "headless-entry.ts"])("%s starts it", (file) => {
		expect(source(file)).toMatch(/^startScheduledLaunchScheduler\(\);$/m);
	});

	it("headless-entry stops it on shutdown", () => {
		expect(source("headless-entry.ts")).toMatch(/^\tstopScheduledLaunchScheduler\(\);$/m);
	});
});
