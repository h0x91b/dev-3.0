/**
 * Reads the top-level resource types out of a Windows PE executable.
 *
 * An icon is a RESOURCE inside the .exe, so "did the icon get embedded" is a
 * question about bytes on disk — not about whether `rcedit` exited 0. Electrobun's
 * icon step exits 0 while embedding nothing (see
 * `decisions/2026/08/06/vendor-rcedit-for-windows-icons.md`), which is exactly why the
 * proof here reads the file rather than trusting a process.
 *
 * Pure byte reading, so it runs on every runner — the assertions do not need a
 * Windows machine even though the subject is a Windows binary.
 */

/** Resource type ids from `winuser.h`. An icon needs BOTH to render. */
export const RT_ICON = 3;
export const RT_GROUP_ICON = 14;

const DOS_SIGNATURE = 0x5a4d; // "MZ"
const PE_SIGNATURE = 0x00004550; // "PE\0\0"
const E_LFANEW_OFFSET = 0x3c;
const COFF_HEADER_SIZE = 20;
const PE32_MAGIC = 0x10b;
const PE32PLUS_MAGIC = 0x20b;
const RESOURCE_DIRECTORY_INDEX = 2;
const SECTION_HEADER_SIZE = 40;
const RESOURCE_DIRECTORY_TABLE_SIZE = 16;
const RESOURCE_DIRECTORY_ENTRY_SIZE = 8;

export class PeFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PeFormatError";
	}
}

function view(bytes: Uint8Array): DataView {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function requireRange(bytes: Uint8Array, offset: number, length: number, what: string): void {
	if (offset < 0 || offset + length > bytes.byteLength) {
		throw new PeFormatError(
			`${what} lies outside the file (needs bytes ${offset}..${offset + length}, file is ${bytes.byteLength} bytes). ` +
				"Cause: the file is truncated or is not a PE executable. " +
				"Fix: rebuild the Windows package and inspect the freshly produced .exe.",
		);
	}
}

interface Section {
	virtualAddress: number;
	virtualSize: number;
	pointerToRawData: number;
	sizeOfRawData: number;
}

/**
 * A resource RVA is an address in the loaded image; the file offset it maps to
 * depends on which section contains it. Without this translation the resource
 * table is read from the wrong place and every executable looks icon-less.
 */
function resolveRva(sections: Section[], rva: number): number {
	for (const section of sections) {
		const size = Math.max(section.virtualSize, section.sizeOfRawData);
		if (rva >= section.virtualAddress && rva < section.virtualAddress + size) {
			return rva - section.virtualAddress + section.pointerToRawData;
		}
	}
	throw new PeFormatError(
		`No PE section contains the resource directory at RVA 0x${rva.toString(16)}. ` +
			"Cause: the executable's section table and its resource directory disagree. " +
			"Fix: rebuild the Windows package; do not ship this binary.",
	);
}

/**
 * Every resource type present in the executable, as a top-level id. Named types
 * (the high bit set on the entry's name field) are skipped — icons are always
 * id-typed, and a named entry carries no id to report.
 */
export function readResourceTypeIds(bytes: Uint8Array): number[] {
	requireRange(bytes, 0, E_LFANEW_OFFSET + 4, "The DOS header");
	const data = view(bytes);
	if (data.getUint16(0, true) !== DOS_SIGNATURE) {
		throw new PeFormatError(
			"File does not start with the DOS signature 'MZ'. " +
				"Cause: this is not a Windows executable. " +
				"Fix: point the icon proof at the packaged .exe, not at another artifact.",
		);
	}

	const peOffset = data.getUint32(E_LFANEW_OFFSET, true);
	requireRange(bytes, peOffset, 4 + COFF_HEADER_SIZE, "The PE header");
	if (data.getUint32(peOffset, true) !== PE_SIGNATURE) {
		throw new PeFormatError(
			`Expected the 'PE\\0\\0' signature at offset ${peOffset}. ` +
				"Cause: the DOS header points somewhere that is not a PE header. " +
				"Fix: the file is corrupt — rebuild the Windows package.",
		);
	}

	const coffOffset = peOffset + 4;
	const sectionCount = data.getUint16(coffOffset + 2, true);
	const optionalHeaderSize = data.getUint16(coffOffset + 16, true);
	const optionalHeaderOffset = coffOffset + COFF_HEADER_SIZE;

	if (optionalHeaderSize === 0) {
		throw new PeFormatError(
			"The PE has no optional header, so it carries no data directories. " +
				"Cause: this is an object file, not an executable. " +
				"Fix: point the icon proof at the packaged .exe.",
		);
	}

	requireRange(bytes, optionalHeaderOffset, 2, "The optional header magic");
	const magic = data.getUint16(optionalHeaderOffset, true);
	// The data directories sit after the optional header's fixed part, whose size
	// is the only thing that differs between PE32 and PE32+.
	const dataDirectoryOffset = optionalHeaderOffset + (magic === PE32PLUS_MAGIC ? 112 : 96);
	if (magic !== PE32_MAGIC && magic !== PE32PLUS_MAGIC) {
		throw new PeFormatError(
			`Unknown optional header magic 0x${magic.toString(16)}. ` +
				"Cause: the file is neither PE32 nor PE32+. " +
				"Fix: rebuild the Windows package with the pinned toolchain.",
		);
	}

	const resourceEntryOffset = dataDirectoryOffset + RESOURCE_DIRECTORY_INDEX * 8;
	requireRange(bytes, resourceEntryOffset, 8, "The resource data directory entry");
	const resourceRva = data.getUint32(resourceEntryOffset, true);
	const resourceSize = data.getUint32(resourceEntryOffset + 4, true);
	if (resourceRva === 0 || resourceSize === 0) {
		return [];
	}

	const sectionTableOffset = optionalHeaderOffset + optionalHeaderSize;
	const sections: Section[] = [];
	for (let index = 0; index < sectionCount; index += 1) {
		const offset = sectionTableOffset + index * SECTION_HEADER_SIZE;
		requireRange(bytes, offset, SECTION_HEADER_SIZE, `Section header ${index}`);
		sections.push({
			virtualSize: data.getUint32(offset + 8, true),
			virtualAddress: data.getUint32(offset + 12, true),
			sizeOfRawData: data.getUint32(offset + 16, true),
			pointerToRawData: data.getUint32(offset + 20, true),
		});
	}

	const tableOffset = resolveRva(sections, resourceRva);
	requireRange(bytes, tableOffset, RESOURCE_DIRECTORY_TABLE_SIZE, "The resource directory table");
	const namedCount = data.getUint16(tableOffset + 12, true);
	const idCount = data.getUint16(tableOffset + 14, true);

	const typeIds: number[] = [];
	for (let index = 0; index < idCount; index += 1) {
		const entryOffset =
			tableOffset + RESOURCE_DIRECTORY_TABLE_SIZE + (namedCount + index) * RESOURCE_DIRECTORY_ENTRY_SIZE;
		requireRange(bytes, entryOffset, RESOURCE_DIRECTORY_ENTRY_SIZE, `Resource type entry ${index}`);
		typeIds.push(data.getUint32(entryOffset, true));
	}
	return typeIds;
}

/**
 * Windows needs the images (`RT_ICON`) AND the group that indexes them
 * (`RT_GROUP_ICON`) to show an icon. Requiring only one lets a half-written
 * resource pass as a working icon.
 */
export function hasEmbeddedIcon(bytes: Uint8Array): boolean {
	const typeIds = readResourceTypeIds(bytes);
	return typeIds.includes(RT_ICON) && typeIds.includes(RT_GROUP_ICON);
}
