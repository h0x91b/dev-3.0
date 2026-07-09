interface ZipEntry {
	name: string;
	data: Uint8Array;
}

const encoder = new TextEncoder();

function writeU16(target: Uint8Array, offset: number, value: number): void {
	new DataView(target.buffer, target.byteOffset, target.byteLength).setUint16(offset, value, true);
}

function writeU32(target: Uint8Array, offset: number, value: number): void {
	new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(offset, value >>> 0, true);
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
	let c = n;
	for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	CRC_TABLE[n] = c >>> 0;
}

function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function safeName(name: string): string {
	const normalized = name.replaceAll("\\", "/");
	if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
		throw new Error(`Unsafe ZIP entry name: ${name}`);
	}
	return normalized;
}

/**
 * Create a standards-compliant ZIP using the STORE method (no compression).
 * HTML is tiny and raster images are already compressed, so avoiding a ZIP
 * dependency keeps artifact export deterministic and available in every app
 * update channel.
 */
export function createStoreZip(entries: ZipEntry[]): Uint8Array {
	const prepared = entries.map((entry) => {
		const name = encoder.encode(safeName(entry.name));
		return { ...entry, name, crc: crc32(entry.data) };
	});
	const localSize = prepared.reduce((sum, entry) => sum + 30 + entry.name.length + entry.data.length, 0);
	const centralSize = prepared.reduce((sum, entry) => sum + 46 + entry.name.length, 0);
	const output = new Uint8Array(localSize + centralSize + 22);
	const offsets: number[] = [];
	let offset = 0;

	for (const entry of prepared) {
		offsets.push(offset);
		writeU32(output, offset, 0x04034b50);
		writeU16(output, offset + 4, 20);
		writeU16(output, offset + 6, 0x0800); // UTF-8 names
		writeU16(output, offset + 8, 0); // STORE
		writeU16(output, offset + 10, 0);
		writeU16(output, offset + 12, 33); // 1980-01-01
		writeU32(output, offset + 14, entry.crc);
		writeU32(output, offset + 18, entry.data.length);
		writeU32(output, offset + 22, entry.data.length);
		writeU16(output, offset + 26, entry.name.length);
		writeU16(output, offset + 28, 0);
		output.set(entry.name, offset + 30);
		output.set(entry.data, offset + 30 + entry.name.length);
		offset += 30 + entry.name.length + entry.data.length;
	}

	const centralOffset = offset;
	prepared.forEach((entry, index) => {
		writeU32(output, offset, 0x02014b50);
		writeU16(output, offset + 4, 20);
		writeU16(output, offset + 6, 20);
		writeU16(output, offset + 8, 0x0800);
		writeU16(output, offset + 10, 0);
		writeU16(output, offset + 12, 0);
		writeU16(output, offset + 14, 33);
		writeU32(output, offset + 16, entry.crc);
		writeU32(output, offset + 20, entry.data.length);
		writeU32(output, offset + 24, entry.data.length);
		writeU16(output, offset + 28, entry.name.length);
		writeU16(output, offset + 30, 0);
		writeU16(output, offset + 32, 0);
		writeU16(output, offset + 34, 0);
		writeU16(output, offset + 36, 0);
		writeU32(output, offset + 38, 0);
		writeU32(output, offset + 42, offsets[index]);
		output.set(entry.name, offset + 46);
		offset += 46 + entry.name.length;
	});

	writeU32(output, offset, 0x06054b50);
	writeU16(output, offset + 4, 0);
	writeU16(output, offset + 6, 0);
	writeU16(output, offset + 8, prepared.length);
	writeU16(output, offset + 10, prepared.length);
	writeU32(output, offset + 12, centralSize);
	writeU32(output, offset + 16, centralOffset);
	writeU16(output, offset + 20, 0);
	return output;
}
