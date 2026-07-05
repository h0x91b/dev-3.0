/**
 * Mach-O headerpad inspection and code-signature space reservation.
 *
 * Zig-built x86_64 Mach-O binaries (Electrobun's extractor/launcher/libasar)
 * ship unsigned with zero headerpad: load commands end exactly where the
 * first `__text` section begins. Apple's `codesign` then has nowhere to put
 * the 16-byte LC_CODE_SIGNATURE load command it must add — and instead of
 * erroring it silently writes the command over the first bytes of `__text`,
 * corrupting the first function. The signature hashes are computed over the
 * corrupted bytes, so verification and notarization pass while the binary
 * segfaults at runtime (issue #563; upstream: ziglang/zig#23704,
 * blackboardsh/electrobun#485; see decision 106).
 *
 * The fix: repurpose the (droppable, same-size) LC_SOURCE_VERSION command as
 * an LC_CODE_SIGNATURE pointing at reserved space appended to `__LINKEDIT`.
 * With a pre-existing signature slot, `codesign --force` re-signs IN PLACE —
 * the same reason arm64 Zig binaries (mandatory linker ad-hoc signature)
 * were never affected.
 */

const MH_MAGIC_64 = 0xfeedfacf;
const MACH_HEADER_SIZE = 32;
const LC_SEGMENT_64 = 0x19;
const LC_CODE_SIGNATURE = 0x1d;
const LC_SOURCE_VERSION = 0x2a;
const SECTION_TYPE_MASK = 0xff;
const S_ZEROFILL = 0x01;
const S_GB_ZEROFILL = 0x0c;
const S_THREAD_LOCAL_ZEROFILL = 0x12;
const SEGMENT_COMMAND_64_SIZE = 72;
const SECTION_64_SIZE = 80;
/** LC_CODE_SIGNATURE (linkedit_data_command) is 16 bytes. */
const CODE_SIGNATURE_LC_SIZE = 16;
/** Space reserved for the future signature blob; codesign reallocates as needed. */
const SIGNATURE_RESERVATION = 0x4000;
/** CSMAGIC_EMBEDDED_SIGNATURE — minimal valid empty SuperBlob for the reserved slot. */
const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;

export interface CodeSignatureInfo {
	/** File offset of the LC_CODE_SIGNATURE load command itself. */
	commandOffset: number;
	dataoff: number;
	datasize: number;
}

export interface LinkeditInfo {
	/** File offset of the __LINKEDIT LC_SEGMENT_64 load command. */
	commandOffset: number;
	fileoff: number;
	filesize: number;
	vmsize: number;
}

export interface MachOInspection {
	ncmds: number;
	sizeofcmds: number;
	/** File offset where load commands end: 32 + sizeofcmds. */
	loadCommandsEnd: number;
	/** Smallest file offset of a non-zerofill section, or null if none. */
	firstSectionOffset: number | null;
	/** firstSectionOffset - loadCommandsEnd (negative means overlap). */
	headerpad: number | null;
	hasCodeSignature: boolean;
	hasSourceVersion: boolean;
	/** File offset of the LC_SOURCE_VERSION command, if present. */
	sourceVersionOffset: number | null;
	codeSignature: CodeSignatureInfo | null;
	linkedit: LinkeditInfo | null;
}

/**
 * Parses a thin 64-bit little-endian Mach-O. Returns null for anything else
 * (fat binaries, 32-bit, non-Mach-O, truncated) — callers treat null as
 * "not a file this module manages".
 */
export function inspectMachO(data: Uint8Array): MachOInspection | null {
	if (data.byteLength < MACH_HEADER_SIZE) return null;
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	if (view.getUint32(0, true) !== MH_MAGIC_64) return null;

	const ncmds = view.getUint32(16, true);
	const sizeofcmds = view.getUint32(20, true);
	const loadCommandsEnd = MACH_HEADER_SIZE + sizeofcmds;
	// A corrupted binary can have loadCommandsEnd past section starts but the
	// commands themselves must still fit in the file to be parseable.
	if (loadCommandsEnd > data.byteLength) return null;

	let firstSectionOffset: number | null = null;
	let hasCodeSignature = false;
	let hasSourceVersion = false;
	let sourceVersionOffset: number | null = null;
	let codeSignature: CodeSignatureInfo | null = null;
	let linkedit: LinkeditInfo | null = null;

	let off = MACH_HEADER_SIZE;
	for (let i = 0; i < ncmds; i++) {
		if (off + 8 > loadCommandsEnd) return null;
		const cmd = view.getUint32(off, true);
		const cmdsize = view.getUint32(off + 4, true);
		if (cmdsize < 8 || off + cmdsize > loadCommandsEnd) return null;

		if (cmd === LC_SEGMENT_64 && cmdsize >= SEGMENT_COMMAND_64_SIZE) {
			const segname = readName(data, off + 8);
			const nsects = view.getUint32(off + 64, true);
			if (segname === "__LINKEDIT") {
				linkedit = {
					commandOffset: off,
					fileoff: Number(view.getBigUint64(off + 40, true)),
					filesize: Number(view.getBigUint64(off + 48, true)),
					vmsize: Number(view.getBigUint64(off + 32, true)),
				};
			}
			for (let s = 0; s < nsects; s++) {
				const sect = off + SEGMENT_COMMAND_64_SIZE + s * SECTION_64_SIZE;
				if (sect + SECTION_64_SIZE > off + cmdsize) break;
				const sectOffset = view.getUint32(sect + 48, true);
				const sectType = view.getUint32(sect + 64, true) & SECTION_TYPE_MASK;
				const isZerofill =
					sectType === S_ZEROFILL ||
					sectType === S_GB_ZEROFILL ||
					sectType === S_THREAD_LOCAL_ZEROFILL;
				if (!isZerofill && sectOffset > 0) {
					if (firstSectionOffset === null || sectOffset < firstSectionOffset) {
						firstSectionOffset = sectOffset;
					}
				}
			}
		} else if (cmd === LC_CODE_SIGNATURE && cmdsize >= CODE_SIGNATURE_LC_SIZE) {
			hasCodeSignature = true;
			codeSignature = {
				commandOffset: off,
				dataoff: view.getUint32(off + 8, true),
				datasize: view.getUint32(off + 12, true),
			};
		} else if (cmd === LC_SOURCE_VERSION) {
			hasSourceVersion = true;
			sourceVersionOffset = off;
		}
		off += cmdsize;
	}

	return {
		ncmds,
		sizeofcmds,
		loadCommandsEnd,
		firstSectionOffset,
		headerpad:
			firstSectionOffset === null ? null : firstSectionOffset - loadCommandsEnd,
		hasCodeSignature,
		hasSourceVersion,
		sourceVersionOffset,
		codeSignature,
		linkedit,
	};
}

/**
 * True when signing this binary with Apple's codesign would corrupt it:
 * no existing LC_CODE_SIGNATURE to replace in place, and not enough
 * headerpad to append one.
 */
export function needsCodeSignatureSpace(info: MachOInspection): boolean {
	if (info.hasCodeSignature) return false;
	if (info.headerpad === null) return false;
	return info.headerpad < CODE_SIGNATURE_LC_SIZE;
}

/**
 * Returns a copy of the binary with LC_SOURCE_VERSION rewritten into an
 * LC_CODE_SIGNATURE pointing at a reserved (minimal valid SuperBlob) slot
 * appended to __LINKEDIT. Throws when the binary cannot be fixed this way.
 */
export function reserveCodeSignatureSpace(data: Uint8Array): Uint8Array {
	const info = inspectMachO(data);
	if (!info) throw new Error("not a thin 64-bit little-endian Mach-O");
	if (info.hasCodeSignature) {
		throw new Error("binary already has an LC_CODE_SIGNATURE");
	}
	if (info.sourceVersionOffset === null) {
		throw new Error("no LC_SOURCE_VERSION load command to repurpose");
	}
	if (!info.linkedit) throw new Error("no __LINKEDIT segment");
	if (info.linkedit.fileoff + info.linkedit.filesize > data.byteLength) {
		throw new Error("__LINKEDIT extends past end of file");
	}

	const sigOff = (data.byteLength + 15) & ~15;
	const fixed = new Uint8Array(sigOff + SIGNATURE_RESERVATION);
	fixed.set(data, 0);
	const view = new DataView(fixed.buffer);

	// Minimal valid empty SuperBlob so tools parsing the "signature" don't choke.
	view.setUint32(sigOff, CSMAGIC_EMBEDDED_SIGNATURE, false);
	view.setUint32(sigOff + 4, 12, false); // blob length
	view.setUint32(sigOff + 8, 0, false); // blob count

	// LC_SOURCE_VERSION -> LC_CODE_SIGNATURE (both are 16 bytes)
	const lc = info.sourceVersionOffset;
	view.setUint32(lc, LC_CODE_SIGNATURE, true);
	view.setUint32(lc + 4, CODE_SIGNATURE_LC_SIZE, true);
	view.setUint32(lc + 8, sigOff, true);
	view.setUint32(lc + 12, SIGNATURE_RESERVATION, true);

	// Grow __LINKEDIT to cover the reservation.
	const seg = info.linkedit.commandOffset;
	const newFilesize = sigOff + SIGNATURE_RESERVATION - info.linkedit.fileoff;
	const newVmsize = (newFilesize + 0x3fff) & ~0x3fff;
	view.setBigUint64(seg + 32, BigInt(newVmsize), true);
	view.setBigUint64(seg + 48, BigInt(newFilesize), true);

	return fixed;
}

export interface OverlapCheck {
	ok: boolean;
	loadCommandsEnd: number;
	firstSectionOffset: number | null;
}

/**
 * Post-signing gate: load commands must never overlap section content.
 * Returns null for non-Mach-O input, ok=false for a corrupted binary
 * (the signature of the codesign clobber).
 */
export function checkLoadCommandOverlap(data: Uint8Array): OverlapCheck | null {
	const info = inspectMachO(data);
	if (!info) return null;
	return {
		ok:
			info.firstSectionOffset === null ||
			info.loadCommandsEnd <= info.firstSectionOffset,
		loadCommandsEnd: info.loadCommandsEnd,
		firstSectionOffset: info.firstSectionOffset,
	};
}

function readName(data: Uint8Array, offset: number): string {
	let end = offset;
	const max = Math.min(offset + 16, data.byteLength);
	while (end < max && data[end] !== 0) end++;
	return new TextDecoder().decode(data.subarray(offset, end));
}
