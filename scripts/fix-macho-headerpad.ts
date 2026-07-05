/**
 * CLI for the Mach-O headerpad fix (issue #563, decision 106).
 *
 * Usage:
 *   bun scripts/fix-macho-headerpad.ts fix <file-or-dir>...
 *   bun scripts/fix-macho-headerpad.ts verify <file-or-dir>...
 *
 * `fix` rewrites unsigned Mach-O binaries that have no room for the
 * LC_CODE_SIGNATURE load command (headerpad < 16), so a later
 * `codesign --force` re-signs in place instead of silently overwriting
 * the start of __text. Run it on node_modules/electrobun/dist-macos-*
 * BEFORE `electrobun build`. No-op for healthy binaries — safe to run
 * unconditionally on any arch.
 *
 * `verify` walks the given paths (e.g. the built .app bundle) and fails
 * with exit 1 if any Mach-O has load commands overlapping section
 * content — the tell-tale corruption left by signing a zero-headerpad
 * binary. Run it AFTER `electrobun build` as a release gate.
 */

import {
	closeSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	checkLoadCommandOverlap,
	inspectMachO,
	needsCodeSignatureSpace,
	reserveCodeSignatureSpace,
} from "../src/bun/macho-headerpad";

function collectFiles(path: string, out: string[] = []): string[] {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink()) return out;
	if (stat.isFile()) {
		out.push(path);
		return out;
	}
	if (stat.isDirectory()) {
		for (const entry of readdirSync(path)) {
			collectFiles(join(path, entry), out);
		}
	}
	return out;
}

/** Cheap magic check so we don't read multi-hundred-MB tarballs into memory. */
function hasMachO64Magic(file: string): boolean {
	const fd = openSync(file, "r");
	try {
		const magic = new Uint8Array(4);
		if (readSync(fd, magic, 0, 4, 0) !== 4) return false;
		// MH_MAGIC_64 little-endian on disk: cf fa ed fe
		return (
			magic[0] === 0xcf &&
			magic[1] === 0xfa &&
			magic[2] === 0xed &&
			magic[3] === 0xfe
		);
	} finally {
		closeSync(fd);
	}
}

function run(): number {
	const [mode, ...paths] = process.argv.slice(2);
	if ((mode !== "fix" && mode !== "verify") || paths.length === 0) {
		console.error(
			"Usage: bun scripts/fix-macho-headerpad.ts <fix|verify> <file-or-dir>...",
		);
		return 2;
	}

	const files = paths.flatMap((p) => collectFiles(p));
	let machoCount = 0;
	let fixedCount = 0;
	let failures = 0;

	for (const file of files) {
		if (!hasMachO64Magic(file)) continue;
		const data = new Uint8Array(readFileSync(file));
		const info = inspectMachO(data);
		if (!info) continue; // not a thin 64-bit Mach-O — not ours to manage
		machoCount++;

		if (mode === "fix") {
			if (!needsCodeSignatureSpace(info)) continue;
			try {
				writeFileSync(file, reserveCodeSignatureSpace(data));
				fixedCount++;
				console.log(
					`fixed: ${file} (headerpad=${info.headerpad} -> reserved LC_CODE_SIGNATURE slot)`,
				);
			} catch (err) {
				failures++;
				console.error(
					`ERROR: ${file} needs a code-signature slot (headerpad=${info.headerpad}) but cannot be fixed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		} else {
			const check = checkLoadCommandOverlap(data);
			if (check && !check.ok) {
				failures++;
				console.error(
					`CORRUPTED: ${file} — load commands end at ${check.loadCommandsEnd}, first section starts at ${check.firstSectionOffset} (codesign clobbered __text; see issue #563)`,
				);
			}
		}
	}

	if (mode === "fix") {
		console.log(
			`fix-macho-headerpad: ${machoCount} Mach-O file(s) scanned, ${fixedCount} fixed, ${failures} failure(s)`,
		);
	} else {
		console.log(
			`fix-macho-headerpad: ${machoCount} Mach-O file(s) verified, ${failures} corrupted`,
		);
	}
	return failures > 0 ? 1 : 0;
}

process.exit(run());
