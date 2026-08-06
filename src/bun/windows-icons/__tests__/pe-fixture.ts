/**
 * Builds a minimal but structurally real PE executable carrying the resource
 * types asked for. Synthetic rather than a checked-in binary so a test can say
 * "this exe has RT_GROUP_ICON but no RT_ICON" and get exactly that.
 */

const DOS_HEADER_SIZE = 0x40;
const COFF_HEADER_SIZE = 20;
const OPTIONAL_HEADER_SIZE = 240; // PE32+ fixed part (112) + 16 data directories
const SECTION_HEADER_SIZE = 40;
const RESOURCE_SECTION_RVA = 0x2000;

export interface PeFixtureOptions {
	resourceTypeIds: number[];
	/** Omit the resource data directory entirely (an exe with no resources at all). */
	withoutResourceDirectory?: boolean;
}

export function buildPeFixture(options: PeFixtureOptions): Uint8Array {
	const { resourceTypeIds, withoutResourceDirectory = false } = options;

	const resourceTable = new Uint8Array(16 + resourceTypeIds.length * 8);
	const resourceView = new DataView(resourceTable.buffer);
	resourceView.setUint16(12, 0, true); // NumberOfNameEntries
	resourceView.setUint16(14, resourceTypeIds.length, true); // NumberOfIdEntries
	resourceTypeIds.forEach((typeId, index) => {
		resourceView.setUint32(16 + index * 8, typeId, true);
		// OffsetToData with the high bit set — points at a subdirectory we never walk.
		resourceView.setUint32(16 + index * 8 + 4, 0x80000000 | 0x100, true);
	});

	const peOffset = DOS_HEADER_SIZE;
	const sectionTableOffset = peOffset + 4 + COFF_HEADER_SIZE + OPTIONAL_HEADER_SIZE;
	const rawDataOffset = sectionTableOffset + SECTION_HEADER_SIZE;

	const bytes = new Uint8Array(rawDataOffset + resourceTable.length);
	const data = new DataView(bytes.buffer);

	data.setUint16(0, 0x5a4d, true); // "MZ"
	data.setUint32(0x3c, peOffset, true);
	data.setUint32(peOffset, 0x00004550, true); // "PE\0\0"

	const coffOffset = peOffset + 4;
	data.setUint16(coffOffset, 0x8664, true); // Machine: x64
	data.setUint16(coffOffset + 2, 1, true); // NumberOfSections
	data.setUint16(coffOffset + 16, OPTIONAL_HEADER_SIZE, true);

	const optionalHeaderOffset = coffOffset + COFF_HEADER_SIZE;
	data.setUint16(optionalHeaderOffset, 0x20b, true); // PE32+
	if (!withoutResourceDirectory) {
		const resourceDirectoryEntry = optionalHeaderOffset + 112 + 2 * 8;
		data.setUint32(resourceDirectoryEntry, RESOURCE_SECTION_RVA, true);
		data.setUint32(resourceDirectoryEntry + 4, resourceTable.length, true);
	}

	bytes.set(new TextEncoder().encode(".rsrc"), sectionTableOffset);
	data.setUint32(sectionTableOffset + 8, resourceTable.length, true); // VirtualSize
	data.setUint32(sectionTableOffset + 12, RESOURCE_SECTION_RVA, true); // VirtualAddress
	data.setUint32(sectionTableOffset + 16, resourceTable.length, true); // SizeOfRawData
	data.setUint32(sectionTableOffset + 20, rawDataOffset, true); // PointerToRawData

	bytes.set(resourceTable, rawDataOffset);
	return bytes;
}

/** An exe Windows would render with the app icon. */
export const PE_WITH_ICON = () => buildPeFixture({ resourceTypeIds: [3, 14, 16] });

/** An exe electrobun's swallowed rcedit failure leaves behind. */
export const PE_WITHOUT_ICON = () => buildPeFixture({ resourceTypeIds: [16] });
