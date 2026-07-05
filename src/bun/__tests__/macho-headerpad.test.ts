import { describe, expect, it } from "vitest";
import {
	checkLoadCommandOverlap,
	inspectMachO,
	needsCodeSignatureSpace,
	reserveCodeSignatureSpace,
} from "../macho-headerpad";

const MH_MAGIC_64 = 0xfeedfacf;
const LC_SEGMENT_64 = 0x19;
const LC_CODE_SIGNATURE = 0x1d;
const LC_SOURCE_VERSION = 0x2a;
const S_ZEROFILL = 0x1;

interface BuildOptions {
	headerpad?: number;
	withCodeSignature?: boolean;
	withSourceVersion?: boolean;
	leadingZerofillSection?: boolean;
}

/**
 * Builds a minimal 64-bit little-endian Mach-O executable:
 * __TEXT segment (with a __text section), __LINKEDIT segment,
 * LC_SOURCE_VERSION, and optionally LC_CODE_SIGNATURE.
 * Mirrors the layout of Zig-built binaries where load commands can end
 * exactly at the first section's file offset (zero headerpad).
 */
function buildMachO(opts: BuildOptions = {}): Uint8Array {
	const {
		headerpad = 0,
		withCodeSignature = false,
		withSourceVersion = true,
		leadingZerofillSection = false,
	} = opts;

	const nsects = leadingZerofillSection ? 2 : 1;
	const textSegSize = 72 + nsects * 80;
	const linkeditSegSize = 72;
	const sourceVersionSize = withSourceVersion ? 16 : 0;
	const codeSignatureSize = withCodeSignature ? 16 : 0;
	const sizeofcmds =
		textSegSize + linkeditSegSize + sourceVersionSize + codeSignatureSize;
	const ncmds =
		2 + (withSourceVersion ? 1 : 0) + (withCodeSignature ? 1 : 0);

	const textOffset = 32 + sizeofcmds + headerpad;
	const textSize = 64;
	const linkeditOffset = textOffset + textSize;
	const linkeditSize = 48;
	const sigOffset = linkeditOffset + linkeditSize;
	const sigSize = withCodeSignature ? 32 : 0;
	const fileSize = sigOffset + sigSize;

	const buf = new Uint8Array(fileSize);
	const view = new DataView(buf.buffer);
	const writeName = (offset: number, name: string) => {
		for (let i = 0; i < name.length; i++) buf[offset + i] = name.charCodeAt(i);
	};

	// mach_header_64
	view.setUint32(0, MH_MAGIC_64, true);
	view.setInt32(4, 0x01000007, true); // CPU_TYPE_X86_64
	view.setInt32(8, 3, true); // CPU_SUBTYPE_X86_64_ALL
	view.setUint32(12, 2, true); // MH_EXECUTE
	view.setUint32(16, ncmds, true);
	view.setUint32(20, sizeofcmds, true);
	view.setUint32(24, 0x00200085, true); // flags

	let off = 32;

	// LC_SEGMENT_64 __TEXT
	view.setUint32(off, LC_SEGMENT_64, true);
	view.setUint32(off + 4, textSegSize, true);
	writeName(off + 8, "__TEXT");
	view.setBigUint64(off + 24, 0x100000000n, true); // vmaddr
	view.setBigUint64(off + 32, BigInt(linkeditOffset), true); // vmsize
	view.setBigUint64(off + 40, 0n, true); // fileoff
	view.setBigUint64(off + 48, BigInt(linkeditOffset), true); // filesize
	view.setInt32(off + 56, 5, true); // maxprot
	view.setInt32(off + 60, 5, true); // initprot
	view.setUint32(off + 64, nsects, true);
	view.setUint32(off + 68, 0, true);
	let sect = off + 72;
	if (leadingZerofillSection) {
		// zerofill sections have file offset 0 and must not be treated as
		// the first section when computing headerpad
		writeName(sect, "__bss");
		writeName(sect + 16, "__TEXT");
		view.setBigUint64(sect + 32, 0x100002000n, true); // addr
		view.setBigUint64(sect + 40, 16n, true); // size
		view.setUint32(sect + 48, 0, true); // offset
		view.setUint32(sect + 64, S_ZEROFILL, true); // flags
		sect += 80;
	}
	writeName(sect, "__text");
	writeName(sect + 16, "__TEXT");
	view.setBigUint64(sect + 32, BigInt(0x100000000 + textOffset), true);
	view.setBigUint64(sect + 40, BigInt(textSize), true);
	view.setUint32(sect + 48, textOffset, true);
	view.setUint32(sect + 52, 4, true); // align
	view.setUint32(sect + 64, 0x80000400, true); // flags
	off += textSegSize;

	// LC_SEGMENT_64 __LINKEDIT
	view.setUint32(off, LC_SEGMENT_64, true);
	view.setUint32(off + 4, linkeditSegSize, true);
	writeName(off + 8, "__LINKEDIT");
	view.setBigUint64(off + 24, 0x100004000n, true);
	view.setBigUint64(off + 32, 0x4000n, true);
	view.setBigUint64(off + 40, BigInt(linkeditOffset), true);
	view.setBigUint64(off + 48, BigInt(fileSize - linkeditOffset), true);
	view.setInt32(off + 56, 1, true);
	view.setInt32(off + 60, 1, true);
	off += linkeditSegSize;

	if (withSourceVersion) {
		view.setUint32(off, LC_SOURCE_VERSION, true);
		view.setUint32(off + 4, 16, true);
		off += 16;
	}
	if (withCodeSignature) {
		view.setUint32(off, LC_CODE_SIGNATURE, true);
		view.setUint32(off + 4, 16, true);
		view.setUint32(off + 8, sigOffset, true);
		view.setUint32(off + 12, sigSize, true);
		off += 16;
	}

	// fill __text with recognizable code bytes, __LINKEDIT with data bytes
	buf.fill(0xaa, textOffset, textOffset + textSize);
	buf.fill(0xbb, linkeditOffset, linkeditOffset + linkeditSize);
	return buf;
}

describe("inspectMachO", () => {
	it("returns null for non-Mach-O data", () => {
		const junk = new Uint8Array(64).fill(0x42);
		expect(inspectMachO(junk)).toBeNull();
	});

	it("returns null for fat binaries and 32-bit Mach-O", () => {
		const fat = new Uint8Array(64);
		new DataView(fat.buffer).setUint32(0, 0xcafebabe, false);
		expect(inspectMachO(fat)).toBeNull();

		const macho32 = new Uint8Array(64);
		new DataView(macho32.buffer).setUint32(0, 0xfeedface, true);
		expect(inspectMachO(macho32)).toBeNull();
	});

	it("returns null for truncated buffers", () => {
		const tiny = new Uint8Array(8);
		new DataView(tiny.buffer).setUint32(0, MH_MAGIC_64, true);
		expect(inspectMachO(tiny)).toBeNull();
	});

	it("parses a zero-headerpad unsigned executable", () => {
		const info = inspectMachO(buildMachO({ headerpad: 0 }));
		expect(info).not.toBeNull();
		expect(info!.hasCodeSignature).toBe(false);
		expect(info!.hasSourceVersion).toBe(true);
		expect(info!.headerpad).toBe(0);
		expect(info!.loadCommandsEnd).toBe(32 + info!.sizeofcmds);
		expect(info!.firstSectionOffset).toBe(info!.loadCommandsEnd);
	});

	it("reports existing code signature", () => {
		const info = inspectMachO(buildMachO({ withCodeSignature: true }));
		expect(info!.hasCodeSignature).toBe(true);
	});

	it("ignores zerofill sections when computing headerpad", () => {
		const info = inspectMachO(
			buildMachO({ headerpad: 8, leadingZerofillSection: true }),
		);
		expect(info!.headerpad).toBe(8);
	});
});

describe("needsCodeSignatureSpace", () => {
	it("is true for unsigned binaries with headerpad < 16", () => {
		expect(needsCodeSignatureSpace(inspectMachO(buildMachO({ headerpad: 0 }))!)).toBe(true);
		expect(needsCodeSignatureSpace(inspectMachO(buildMachO({ headerpad: 8 }))!)).toBe(true);
	});

	it("is false when the LC_CODE_SIGNATURE fits in the pad", () => {
		expect(needsCodeSignatureSpace(inspectMachO(buildMachO({ headerpad: 16 }))!)).toBe(false);
		expect(needsCodeSignatureSpace(inspectMachO(buildMachO({ headerpad: 4096 }))!)).toBe(false);
	});

	it("is false when a code signature already exists", () => {
		expect(
			needsCodeSignatureSpace(
				inspectMachO(buildMachO({ headerpad: 0, withCodeSignature: true }))!,
			),
		).toBe(false);
	});
});

describe("reserveCodeSignatureSpace", () => {
	it("converts LC_SOURCE_VERSION into a reserved LC_CODE_SIGNATURE without touching code", () => {
		const original = buildMachO({ headerpad: 0 });
		const before = inspectMachO(original)!;
		const fixed = reserveCodeSignatureSpace(original);
		const after = inspectMachO(fixed)!;

		// header geometry unchanged — this is the whole point: no load command growth
		expect(after.ncmds).toBe(before.ncmds);
		expect(after.sizeofcmds).toBe(before.sizeofcmds);
		expect(after.hasCodeSignature).toBe(true);
		expect(after.hasSourceVersion).toBe(false);

		// __text bytes untouched at the same offsets
		const textOff = before.firstSectionOffset!;
		for (let i = 0; i < 64; i++) {
			expect(fixed[textOff + i]).toBe(0xaa);
		}

		// reservation appended: 16-aligned offset, minimal valid SuperBlob magic
		expect(fixed.length).toBeGreaterThan(original.length);
		const sig = after.codeSignature!;
		expect(sig.dataoff % 16).toBe(0);
		expect(sig.dataoff).toBeGreaterThanOrEqual(original.length);
		expect(sig.dataoff + sig.datasize).toBe(fixed.length);
		const view = new DataView(fixed.buffer, fixed.byteOffset);
		expect(view.getUint32(sig.dataoff, false)).toBe(0xfade0cc0);

		// __LINKEDIT now covers the reservation
		expect(after.linkedit).not.toBeNull();
		expect(after.linkedit!.fileoff + after.linkedit!.filesize).toBe(fixed.length);
	});

	it("throws when the binary already has a code signature", () => {
		expect(() =>
			reserveCodeSignatureSpace(buildMachO({ withCodeSignature: true })),
		).toThrow(/already/i);
	});

	it("throws when there is no LC_SOURCE_VERSION to repurpose", () => {
		expect(() =>
			reserveCodeSignatureSpace(buildMachO({ withSourceVersion: false })),
		).toThrow(/LC_SOURCE_VERSION/);
	});

	it("throws on non-Mach-O input", () => {
		expect(() => reserveCodeSignatureSpace(new Uint8Array(64))).toThrow(/Mach-O/);
	});
});

describe("checkLoadCommandOverlap", () => {
	it("passes a clean binary", () => {
		const result = checkLoadCommandOverlap(buildMachO({ headerpad: 0 }));
		expect(result).not.toBeNull();
		expect(result!.ok).toBe(true);
	});

	it("detects load commands overlapping __text (the codesign clobber)", () => {
		// Simulate what Apple's codesign does to a zero-headerpad binary:
		// grow ncmds/sizeofcmds so the new LC_CODE_SIGNATURE lands inside __text.
		const corrupted = buildMachO({ headerpad: 0 });
		const view = new DataView(corrupted.buffer);
		view.setUint32(16, view.getUint32(16, true) + 1, true); // ncmds
		view.setUint32(20, view.getUint32(20, true) + 16, true); // sizeofcmds
		const cmdsEnd = 32 + view.getUint32(20, true);
		// the clobber itself: a valid linkedit_data_command over the code bytes
		view.setUint32(cmdsEnd - 16, 0x1d, true);
		view.setUint32(cmdsEnd - 12, 16, true);
		view.setUint32(cmdsEnd - 8, corrupted.length, true);
		view.setUint32(cmdsEnd - 4, 0, true);

		const result = checkLoadCommandOverlap(corrupted);
		expect(result).not.toBeNull();
		expect(result!.ok).toBe(false);
	});

	it("returns null for non-Mach-O input", () => {
		expect(checkLoadCommandOverlap(new Uint8Array(32))).toBeNull();
	});

	it("passes a fixed-then-inspected binary end to end", () => {
		const fixed = reserveCodeSignatureSpace(buildMachO({ headerpad: 0 }));
		expect(checkLoadCommandOverlap(fixed)!.ok).toBe(true);
	});
});
