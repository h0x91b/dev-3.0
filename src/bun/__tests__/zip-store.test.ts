import { describe, expect, it } from "vitest";
import { createStoreZip } from "../zip-store";

describe("createStoreZip", () => {
	it("writes portable UTF-8 ZIP entries without compression", () => {
		const zip = createStoreZip([
			{ name: "report.html", data: new TextEncoder().encode("<h1>Hello</h1>") },
			{ name: "chart.png", data: new Uint8Array([1, 2, 3, 4]) },
		]);
		const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
		const text = new TextDecoder().decode(zip);

		expect(view.getUint32(0, true)).toBe(0x04034b50);
		expect(text).toContain("report.html");
		expect(text).toContain("<h1>Hello</h1>");
		expect(text).toContain("chart.png");
		expect(view.getUint32(zip.length - 22, true)).toBe(0x06054b50);
		expect(view.getUint16(zip.length - 12, true)).toBe(2);
	});

	it("rejects unsafe archive names", () => {
		expect(() => createStoreZip([{ name: "../secret", data: new Uint8Array() }])).toThrow(/Unsafe ZIP entry/);
		expect(() => createStoreZip([{ name: "/absolute", data: new Uint8Array() }])).toThrow(/Unsafe ZIP entry/);
	});
});
