import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { createZip } from "../zip";

describe("createZip", () => {
	it("deflates compressible entries and preserves their original bytes", () => {
		const source = new TextEncoder().encode("<article>Artifact report</article>".repeat(100));
		const zip = createZip([{ name: "report.html", data: source }]);
		const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
		const nameLength = view.getUint16(26, true);
		const extraLength = view.getUint16(28, true);
		const compressedSize = view.getUint32(18, true);
		const dataOffset = 30 + nameLength + extraLength;
		const compressed = zip.subarray(dataOffset, dataOffset + compressedSize);

		expect(view.getUint32(0, true)).toBe(0x04034b50);
		expect(view.getUint16(8, true)).toBe(8);
		expect(compressedSize).toBeLessThan(source.byteLength);
		expect(new Uint8Array(inflateRawSync(compressed))).toEqual(source);
		expect(view.getUint32(zip.length - 22, true)).toBe(0x06054b50);
		expect(view.getUint16(zip.length - 12, true)).toBe(1);
		const centralOffset = view.getUint32(zip.length - 6, true);
		expect(view.getUint32(centralOffset, true)).toBe(0x02014b50);
		expect(view.getUint16(centralOffset + 10, true)).toBe(8);
		expect(view.getUint32(centralOffset + 20, true)).toBe(compressedSize);
		expect(view.getUint32(centralOffset + 24, true)).toBe(source.byteLength);
	});

	it("stores an entry when deflate would make it larger", () => {
		const source = new Uint8Array([1, 2, 3, 4]);
		const zip = createZip([{ name: "tiny.bin", data: source }]);
		const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
		const nameLength = view.getUint16(26, true);
		const dataOffset = 30 + nameLength + view.getUint16(28, true);

		expect(view.getUint16(8, true)).toBe(0);
		expect(zip.subarray(dataOffset, dataOffset + source.byteLength)).toEqual(source);
	});

	it("rejects unsafe archive names", () => {
		expect(() => createZip([{ name: "../secret", data: new Uint8Array() }])).toThrow(/Unsafe ZIP entry/);
		expect(() => createZip([{ name: "/absolute", data: new Uint8Array() }])).toThrow(/Unsafe ZIP entry/);
	});
});
