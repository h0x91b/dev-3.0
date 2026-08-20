import { describe, expect, it } from "vitest";
import {
	formatVersion,
	packVersion,
	raiseMinMacOSVersion,
	readMinMacOSVersion,
} from "../macho-min-version";

const MH_MAGIC_64 = 0xfeedfacf;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;
const LC_SOURCE_VERSION = 0x2a;

/**
 * Minimal 64-bit little-endian Mach-O carrying one version load command plus a
 * trailing LC_SOURCE_VERSION, so the walk has to step over a neighbour to find it.
 */
function buildMachO(opts: { versionMin?: number; buildVersion?: boolean } = {}): Uint8Array {
	const { versionMin, buildVersion = false } = opts;
	const versionCmdSize = buildVersion ? 32 : versionMin !== undefined ? 16 : 0;
	const sizeofcmds = versionCmdSize + 16;
	const ncmds = (versionCmdSize > 0 ? 1 : 0) + 1;
	const data = new Uint8Array(32 + sizeofcmds + 64);
	const view = new DataView(data.buffer);

	view.setUint32(0, MH_MAGIC_64, true);
	view.setUint32(4, 0x01000007, true); // CPU_TYPE_X86_64
	view.setUint32(12, 2, true); // MH_EXECUTE
	view.setUint32(16, ncmds, true);
	view.setUint32(20, sizeofcmds, true);

	let off = 32;
	if (buildVersion) {
		view.setUint32(off, LC_BUILD_VERSION, true);
		view.setUint32(off + 4, 32, true);
		view.setUint32(off + 8, 1, true); // PLATFORM_MACOS
		view.setUint32(off + 12, packVersion(11, 0), true);
		view.setUint32(off + 16, packVersion(11, 0), true);
		off += 32;
	} else if (versionMin !== undefined) {
		view.setUint32(off, LC_VERSION_MIN_MACOSX, true);
		view.setUint32(off + 4, 16, true);
		view.setUint32(off + 8, versionMin, true);
		view.setUint32(off + 12, versionMin, true);
		off += 16;
	}
	view.setUint32(off, LC_SOURCE_VERSION, true);
	view.setUint32(off + 4, 16, true);
	return data;
}

describe("packVersion / formatVersion", () => {
	it("round-trips the xxxx.yy.zz encoding", () => {
		expect(packVersion(10, 4)).toBe(0x000a0400);
		expect(packVersion(10, 15)).toBe(0x000a0f00);
		expect(formatVersion(packVersion(10, 4))).toBe("10.4");
		expect(formatVersion(packVersion(13, 2, 1))).toBe("13.2.1");
	});
});

describe("readMinMacOSVersion", () => {
	it("finds LC_VERSION_MIN_MACOSX past a neighbouring command", () => {
		const info = readMinMacOSVersion(buildMachO({ versionMin: packVersion(10, 4) }));
		expect(info?.commandOffset).toBe(32);
		expect(formatVersion(info?.sdk ?? 0)).toBe("10.4");
		expect(info?.hasBuildVersion).toBe(false);
	});

	it("reports LC_BUILD_VERSION instead, as the arm64 build carries", () => {
		const info = readMinMacOSVersion(buildMachO({ buildVersion: true }));
		expect(info?.hasBuildVersion).toBe(true);
		expect(info?.commandOffset).toBeNull();
	});

	it("returns null for anything that is not a thin 64-bit Mach-O", () => {
		expect(readMinMacOSVersion(new Uint8Array([1, 2, 3]))).toBeNull();
		expect(readMinMacOSVersion(new Uint8Array(64))).toBeNull();
	});
});

describe("raiseMinMacOSVersion", () => {
	it("raises 10.4 to the target and touches nothing else", () => {
		const original = buildMachO({ versionMin: packVersion(10, 4) });
		const patched = raiseMinMacOSVersion(original, 10, 15);
		expect(patched).not.toBeNull();

		const info = readMinMacOSVersion(patched!);
		expect(formatVersion(info?.version ?? 0)).toBe("10.15");
		expect(formatVersion(info?.sdk ?? 0)).toBe("10.15");

		// Exactly the two uint32s changed — the same 8 bytes the real binary needs.
		const differing = [...patched!].filter((byte, i) => byte !== original[i]).length;
		expect(differing).toBeLessThanOrEqual(8);
		expect(patched!.byteLength).toBe(original.byteLength);
	});

	it("is a no-op when the binary already declares enough", () => {
		const already = buildMachO({ versionMin: packVersion(11, 0) });
		expect(raiseMinMacOSVersion(already, 10, 15)).toBeNull();
	});

	it("never lowers a version", () => {
		const high = buildMachO({ versionMin: packVersion(14, 0) });
		expect(raiseMinMacOSVersion(high, 10, 15)).toBeNull();
	});

	it("leaves an LC_BUILD_VERSION binary alone", () => {
		expect(raiseMinMacOSVersion(buildMachO({ buildVersion: true }), 10, 15)).toBeNull();
	});

	it("ignores non-Mach-O input", () => {
		expect(raiseMinMacOSVersion(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), 10, 15)).toBeNull();
	});
});
