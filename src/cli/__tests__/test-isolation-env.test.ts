import { describe, expect, it } from "vitest";
import { AGENT_STORE_ENV } from "../../../test-isolation";

// The CLI suite has no setup file; its isolation comes only from the Vitest config.
describe("CLI test isolation", () => {
	it("starts workers without any agent-store redirect from the launching shell", () => {
		for (const key of AGENT_STORE_ENV) expect(process.env[key]).toBeUndefined();
	});
});
