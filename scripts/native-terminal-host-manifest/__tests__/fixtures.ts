/**
 * Fixture data for the native-terminal-host manifest tests. Each platform
 * fixture is a data table (metadata + declared files with fixed byte content)
 * that a test materializes into a fresh temporary directory — no fixture bytes
 * are committed, so there is no line-ending / checkout drift to poison the
 * checksums, and nothing outside a tmpdir is touched.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ManifestMetadata } from "../manifest";

export interface FixtureFile {
	/** POSIX relative path inside the artifact root. */
	path: string;
	/** Exact bytes written to disk (kept ASCII so content is byte-stable). */
	contents: string;
}

export interface PlatformFixture {
	name: string;
	metadata: ManifestMetadata;
	entrypoint: string;
	files: FixtureFile[];
}

export const WINDOWS_X64_FIXTURE: PlatformFixture = {
	name: "windows-x64",
	metadata: { hostVersion: "1.4.0", protocolVersion: 2, bunVersion: "1.3.14", os: "win32", arch: "x64" },
	entrypoint: "dev3-terminal-host.js",
	files: [
		{ path: "dev3-terminal-host.js", contents: "// dev3 windows terminal host entrypoint\nconsole.log('host');\n" },
		{ path: "conpty/conpty.dll", contents: "MZ\x00windows-conpty-dll-bytes" },
		{ path: "conpty/OpenConsole.exe", contents: "MZ\x00windows-openconsole-bytes" },
		{ path: "runtime/bun.exe", contents: "bun-windows-runtime-x64" },
	],
};

export const MACOS_ARM64_FIXTURE: PlatformFixture = {
	name: "macos-arm64",
	metadata: { hostVersion: "1.4.0", protocolVersion: 2, bunVersion: "1.3.14", os: "darwin", arch: "arm64" },
	entrypoint: "dev3-terminal-host.js",
	files: [
		{ path: "dev3-terminal-host.js", contents: "// dev3 macos terminal host entrypoint\nconsole.log('host');\n" },
		{ path: "runtime/bun", contents: "\x7fELF-not-really-macho-bun-arm64" },
		{ path: "Frameworks/libnative.dylib", contents: "macho-dylib-bytes-arm64" },
	],
};

export const LINUX_X64_FIXTURE: PlatformFixture = {
	name: "linux-x64",
	metadata: { hostVersion: "1.4.0", protocolVersion: 2, bunVersion: "1.3.14", os: "linux", arch: "x64" },
	entrypoint: "dev3-terminal-host.js",
	files: [
		{ path: "dev3-terminal-host.js", contents: "// dev3 linux terminal host entrypoint\nconsole.log('host');\n" },
		{ path: "runtime/bun", contents: "\x7fELF-bun-linux-x64" },
		{ path: "lib/libnative.so", contents: "\x7fELF-libnative-so-x64" },
	],
};

export const PLATFORM_FIXTURES: PlatformFixture[] = [WINDOWS_X64_FIXTURE, MACOS_ARM64_FIXTURE, LINUX_X64_FIXTURE];

export interface MaterializedFixture {
	root: string;
	cleanup: () => void;
}

/** Write a fixture's files into a fresh tmp directory. Caller must cleanup(). */
export function materializeFixture(fixture: PlatformFixture, extraFiles: FixtureFile[] = []): MaterializedFixture {
	const root = mkdtempSync(join(tmpdir(), `dev3-manifest-${fixture.name}-`));
	for (const file of [...fixture.files, ...extraFiles]) {
		const absolutePath = join(root, file.path);
		mkdirSync(dirname(absolutePath), { recursive: true });
		writeFileSync(absolutePath, Buffer.from(file.contents, "binary"));
	}
	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Declared file list for a fixture, in author order (deliberately unsorted). */
export function declaredFiles(fixture: PlatformFixture): string[] {
	return fixture.files.map((file) => file.path);
}
