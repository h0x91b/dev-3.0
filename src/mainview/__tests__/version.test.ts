import { describe, it, expect } from "vitest";
import { isNewerVersion } from "../../shared/version";

describe("isNewerVersion", () => {
	it("returns true when remote major is greater", () => {
		expect(isNewerVersion("0.2.9", "1.0.0")).toBe(true);
	});

	it("returns true when remote minor is greater", () => {
		expect(isNewerVersion("0.2.9", "0.3.0")).toBe(true);
	});

	it("returns true when remote patch is greater", () => {
		expect(isNewerVersion("0.2.9", "0.2.10")).toBe(true);
		expect(isNewerVersion("0.2.9", "0.2.11")).toBe(true);
	});

	it("returns false when versions are equal", () => {
		expect(isNewerVersion("0.2.9", "0.2.9")).toBe(false);
	});

	it("returns false when remote is older", () => {
		expect(isNewerVersion("0.2.11", "0.2.9")).toBe(false);
		expect(isNewerVersion("1.0.0", "0.9.99")).toBe(false);
	});

	it("handles v prefix", () => {
		expect(isNewerVersion("v0.2.9", "v0.2.10")).toBe(true);
		expect(isNewerVersion("v0.2.9", "0.2.10")).toBe(true);
		expect(isNewerVersion("0.2.9", "v0.2.10")).toBe(true);
	});

	it("handles two-part versions", () => {
		expect(isNewerVersion("0.2", "0.3")).toBe(true);
		expect(isNewerVersion("0.2", "0.2")).toBe(false);
	});
});
