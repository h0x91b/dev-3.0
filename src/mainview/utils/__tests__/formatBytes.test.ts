import { describe, it, expect } from "vitest";
import { formatBytes } from "../formatBytes";

describe("formatBytes", () => {
	it("returns bytes for values under 1 KB", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(1)).toBe("1 B");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(1023)).toBe("1023 B");
	});

	it("returns KB for values in the kilobyte range", () => {
		expect(formatBytes(1024)).toBe("1 KB");
		expect(formatBytes(2048)).toBe("2 KB");
		expect(formatBytes(1024 * 500)).toBe("500 KB");
		expect(formatBytes(1024 * 1024 - 1)).toBe("1024 KB");
	});

	it("returns MB for values in the megabyte range", () => {
		expect(formatBytes(1024 * 1024)).toBe("1 MB");
		expect(formatBytes(1024 * 1024 * 256)).toBe("256 MB");
		expect(formatBytes(1024 * 1024 * 1023)).toBe("1023 MB");
	});

	it("returns GB for values >= 1 GB", () => {
		expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
		expect(formatBytes(1024 * 1024 * 1024 * 1.5)).toBe("1.5 GB");
		expect(formatBytes(1024 * 1024 * 1024 * 4)).toBe("4.0 GB");
		expect(formatBytes(1024 * 1024 * 1024 * 8.9)).toBe("8.9 GB");
	});
});
