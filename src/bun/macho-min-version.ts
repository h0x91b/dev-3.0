/**
 * Raise the declared minimum macOS version of a Mach-O binary.
 *
 * Apple's notary service rejects any nested binary whose declared SDK is older
 * than 10.9 ("The binary uses an SDK older than the 10.9 SDK.", status 4000) and
 * fails the WHOLE archive. The vendored bifrost proxy's darwin/amd64 build ships
 * `LC_VERSION_MIN_MACOSX version 10.4 sdk 10.4`; its arm64 build carries a modern
 * LC_BUILD_VERSION, which is why only Intel notarization died.
 *
 * Rewriting the two uint32s in place touches exactly 8 bytes and moves nothing.
 * Apple's own `vtool -set-version-min` reaches the same declared version but
 * REORDERS the load-command table on the way (311 bytes differ on the real
 * binary), and `vtool -replace` would swap in a 32-byte LC_BUILD_VERSION, which
 * needs headerpad this binary has no guarantee of. Verified against `otool -l`.
 */

const MH_MAGIC_64 = 0xfeedfacf;
const MACH_HEADER_SIZE = 32;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;
/** Apple's floor. A binary at or above this notarizes. */
export const NOTARIZATION_MIN_MACOS = { major: 10, minor: 9 };

export interface MinVersionInfo {
	/** File offset of the LC_VERSION_MIN_MACOSX command, or null when absent. */
	commandOffset: number | null;
	/** Packed `version` field, or null. */
	version: number | null;
	/** Packed `sdk` field, or null. */
	sdk: number | null;
	/** A modern LC_BUILD_VERSION is present — nothing to raise. */
	hasBuildVersion: boolean;
}

/** Packs X.Y.Z into the Mach-O `xxxx.yy.zz` uint32 encoding. */
export function packVersion(major: number, minor: number, patch = 0): number {
	return ((major & 0xffff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

/** Reads the version load commands. Returns null for anything that is not a
 *  thin 64-bit little-endian Mach-O — callers treat that as "not ours". */
export function readMinMacOSVersion(data: Uint8Array): MinVersionInfo | null {
	if (data.byteLength < MACH_HEADER_SIZE) return null;
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	if (view.getUint32(0, true) !== MH_MAGIC_64) return null;

	const ncmds = view.getUint32(16, true);
	const loadCommandsEnd = MACH_HEADER_SIZE + view.getUint32(20, true);
	if (loadCommandsEnd > data.byteLength) return null;

	const info: MinVersionInfo = {
		commandOffset: null,
		version: null,
		sdk: null,
		hasBuildVersion: false,
	};
	let off = MACH_HEADER_SIZE;
	for (let i = 0; i < ncmds; i++) {
		if (off + 8 > loadCommandsEnd) return null;
		const cmd = view.getUint32(off, true);
		const cmdsize = view.getUint32(off + 4, true);
		if (cmdsize < 8 || off + cmdsize > loadCommandsEnd) return null;
		if (cmd === LC_VERSION_MIN_MACOSX && cmdsize >= 16) {
			info.commandOffset = off;
			info.version = view.getUint32(off + 8, true);
			info.sdk = view.getUint32(off + 12, true);
		} else if (cmd === LC_BUILD_VERSION) {
			info.hasBuildVersion = true;
		}
		off += cmdsize;
	}
	return info;
}

/**
 * Returns a copy with `version` and `sdk` raised to the target, or null when
 * nothing had to change (already high enough, LC_BUILD_VERSION, not a Mach-O).
 * Never lowers a version.
 */
export function raiseMinMacOSVersion(
	data: Uint8Array,
	major: number,
	minor: number,
): Uint8Array | null {
	const info = readMinMacOSVersion(data);
	if (!info || info.commandOffset === null) return null;
	const target = packVersion(major, minor);
	if ((info.version ?? 0) >= target && (info.sdk ?? 0) >= target) return null;

	const patched = new Uint8Array(data);
	const view = new DataView(patched.buffer);
	if ((info.version ?? 0) < target) view.setUint32(info.commandOffset + 8, target, true);
	if ((info.sdk ?? 0) < target) view.setUint32(info.commandOffset + 12, target, true);
	return patched;
}

/** Human-readable "10.4" from the packed encoding. */
export function formatVersion(packed: number): string {
	const patch = packed & 0xff;
	const minor = (packed >> 8) & 0xff;
	const major = packed >> 16;
	return patch === 0 ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
}
