/**
 * Fixture-driven tests for the native-terminal-host ARTIFACT manifest generator
 * + validator (`bun run test:bun`).
 *
 * Covers Windows x64, macOS arm64, Linux x64 happy paths, byte-level
 * determinism, and every typed rejection.
 */

import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	enumerateArtifactFiles,
	generateManifest,
	ManifestError,
	MANIFEST_SCHEMA_VERSION,
	parseManifest,
	serializeManifest,
	validateManifest,
	type GenerateManifestInput,
	type ManifestErrorCode,
	type ManifestMetadata,
} from "../artifact-manifest";
import {
	declaredFiles,
	LINUX_X64_FIXTURE,
	MACOS_ARM64_FIXTURE,
	materializeFixture,
	PLATFORM_FIXTURES,
	WINDOWS_X64_FIXTURE,
	type PlatformFixture,
} from "./artifact-manifest-fixtures";

function sha256(contents: string): string {
	return createHash("sha256").update(Buffer.from(contents, "binary")).digest("hex");
}

function byteLength(contents: string): number {
	return Buffer.from(contents, "binary").length;
}

function inputFor(fixture: PlatformFixture, root: string, overrides: Partial<GenerateManifestInput> = {}): GenerateManifestInput {
	return { artifactRoot: root, entrypoint: fixture.entrypoint, files: declaredFiles(fixture), metadata: fixture.metadata, ...overrides };
}

function expectManifestError(fn: () => unknown, code: ManifestErrorCode): ManifestError {
	let thrown: unknown;
	try {
		fn();
	} catch (err) {
		thrown = err;
	}
	expect(thrown).toBeInstanceOf(ManifestError);
	expect((thrown as ManifestError).code).toBe(code);
	return thrown as ManifestError;
}

describe("generateManifest — platform happy paths", () => {
	for (const fixture of PLATFORM_FIXTURES) {
		test(`${fixture.name}: manifest carries metadata, sizes, and checksums`, () => {
			const { root, cleanup } = materializeFixture(fixture);
			try {
				const manifest = generateManifest(inputFor(fixture, root));

				expect(manifest.manifestSchemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
				expect(manifest.hostVersion).toBe(fixture.metadata.hostVersion);
				expect(manifest.protocolVersion).toBe(fixture.metadata.protocolVersion);
				expect(manifest.bunVersion).toBe(fixture.metadata.bunVersion);
				expect(manifest.os).toBe(fixture.metadata.os);
				expect(manifest.arch).toBe(fixture.metadata.arch);
				expect(manifest.entrypoint).toBe(fixture.entrypoint);
				expect(manifest.files).toHaveLength(fixture.files.length);

				for (const fixtureFile of fixture.files) {
					const entry = manifest.files.find((candidate) => candidate.path === fixtureFile.path);
					expect(entry).toBeDefined();
					expect(entry?.size).toBe(byteLength(fixtureFile.contents));
					expect(entry?.sha256).toBe(sha256(fixtureFile.contents));
				}
			} finally {
				cleanup();
			}
		});
	}

	test("files are sorted by POSIX path with locale-independent code-unit order", () => {
		const { root, cleanup } = materializeFixture(WINDOWS_X64_FIXTURE);
		try {
			const manifest = generateManifest(inputFor(WINDOWS_X64_FIXTURE, root));
			expect(manifest.files.map((entry) => entry.path)).toEqual([
				"conpty/OpenConsole.exe", // uppercase 'O' sorts before lowercase 'c'
				"conpty/conpty.dll",
				"dev3-terminal-host.js",
				"runtime/bun.exe",
			]);
		} finally {
			cleanup();
		}
	});

	test("backslash-separated declared paths normalize to forward slashes", () => {
		const { root, cleanup } = materializeFixture(WINDOWS_X64_FIXTURE);
		try {
			const manifest = generateManifest(
				inputFor(WINDOWS_X64_FIXTURE, root, { files: ["dev3-terminal-host.js", "conpty\\conpty.dll", "conpty\\OpenConsole.exe", "runtime\\bun.exe"] }),
			);
			expect(manifest.files.map((entry) => entry.path)).toContain("conpty/conpty.dll");
			expect(manifest.files.every((entry) => !entry.path.includes("\\"))).toBe(true);
		} finally {
			cleanup();
		}
	});
});

describe("determinism", () => {
	test("identical input yields byte-identical serialized output", () => {
		const { root, cleanup } = materializeFixture(LINUX_X64_FIXTURE);
		try {
			const first = serializeManifest(generateManifest(inputFor(LINUX_X64_FIXTURE, root)));
			const second = serializeManifest(generateManifest(inputFor(LINUX_X64_FIXTURE, root)));
			expect(first).toBe(second);
			expect(first.endsWith("\n")).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("declared-file order does not affect output", () => {
		const { root, cleanup } = materializeFixture(MACOS_ARM64_FIXTURE);
		try {
			const forward = serializeManifest(generateManifest(inputFor(MACOS_ARM64_FIXTURE, root)));
			const reversed = serializeManifest(generateManifest(inputFor(MACOS_ARM64_FIXTURE, root, { files: [...declaredFiles(MACOS_ARM64_FIXTURE)].reverse() })));
			expect(forward).toBe(reversed);
		} finally {
			cleanup();
		}
	});

	test("file timestamps do not affect output", () => {
		const { root, cleanup } = materializeFixture(LINUX_X64_FIXTURE);
		try {
			const before = serializeManifest(generateManifest(inputFor(LINUX_X64_FIXTURE, root)));
			for (const fixtureFile of LINUX_X64_FIXTURE.files) {
				utimesSync(join(root, fixtureFile.path), new Date(0), new Date(0));
			}
			const after = serializeManifest(generateManifest(inputFor(LINUX_X64_FIXTURE, root)));
			expect(before).toBe(after);
		} finally {
			cleanup();
		}
	});

	test("enumerateArtifactFiles returns a sorted, enumeration-order-independent list", () => {
		const { root, cleanup } = materializeFixture(WINDOWS_X64_FIXTURE);
		try {
			const enumerated = enumerateArtifactFiles(root);
			expect(enumerated).toEqual([...enumerated].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
			// Enumerated list drives an identical manifest to the explicit declared list.
			const fromEnumerated = serializeManifest(generateManifest(inputFor(WINDOWS_X64_FIXTURE, root, { files: enumerated })));
			const fromDeclared = serializeManifest(generateManifest(inputFor(WINDOWS_X64_FIXTURE, root)));
			expect(fromEnumerated).toBe(fromDeclared);
		} finally {
			cleanup();
		}
	});
});

describe("round-trip parse + validate", () => {
	for (const fixture of PLATFORM_FIXTURES) {
		test(`${fixture.name}: serialize → parse → validate is lossless`, () => {
			const { root, cleanup } = materializeFixture(fixture);
			try {
				const manifest = generateManifest(inputFor(fixture, root));
				const parsed = parseManifest(serializeManifest(manifest));
				expect(parsed).toEqual(manifest);
				expect(validateManifest(serializeManifest(manifest), root)).toEqual(manifest);
			} finally {
				cleanup();
			}
		});
	}
});

describe("rejections — generation", () => {
	test("missing: absent artifact root", () => {
		expectManifestError(() => generateManifest(inputFor(WINDOWS_X64_FIXTURE, join(WINDOWS_X64_FIXTURE.name, "does-not-exist-xyz"))), "missing");
	});

	test("missing: root path is a file, not a directory", () => {
		const { root, cleanup } = materializeFixture(LINUX_X64_FIXTURE);
		try {
			expectManifestError(() => generateManifest(inputFor(LINUX_X64_FIXTURE, join(root, "dev3-terminal-host.js"))), "missing");
		} finally {
			cleanup();
		}
	});

	test("partial: a declared file is absent from an existing root", () => {
		const { root, cleanup } = materializeFixture(WINDOWS_X64_FIXTURE);
		try {
			const err = expectManifestError(
				() => generateManifest(inputFor(WINDOWS_X64_FIXTURE, root, { files: [...declaredFiles(WINDOWS_X64_FIXTURE), "missing/extra.bin"] })),
				"partial",
			);
			expect(err.detail.paths).toContain("missing/extra.bin");
		} finally {
			cleanup();
		}
	});

	test("path-traversal: parent escape, absolute path, and drive letter", () => {
		const { root, cleanup } = materializeFixture(LINUX_X64_FIXTURE);
		try {
			for (const bad of ["../escape.bin", "/etc/passwd", "C:/windows/system32.dll", "a/../../b"]) {
				expectManifestError(() => generateManifest(inputFor(LINUX_X64_FIXTURE, root, { files: [bad, ...declaredFiles(LINUX_X64_FIXTURE)] })), "path-traversal");
			}
		} finally {
			cleanup();
		}
	});

	test("duplicate: same path twice, including separator-normalized duplicates", () => {
		const { root, cleanup } = materializeFixture(MACOS_ARM64_FIXTURE);
		try {
			expectManifestError(() => generateManifest(inputFor(MACOS_ARM64_FIXTURE, root, { files: ["dev3-terminal-host.js", "dev3-terminal-host.js"] })), "duplicate");
			expectManifestError(() => generateManifest(inputFor(MACOS_ARM64_FIXTURE, root, { files: ["runtime/bun", "runtime\\bun"] })), "duplicate");
		} finally {
			cleanup();
		}
	});

	test("not-regular: a declared path points at a directory", () => {
		const { root, cleanup } = materializeFixture(WINDOWS_X64_FIXTURE);
		try {
			expectManifestError(() => generateManifest(inputFor(WINDOWS_X64_FIXTURE, root, { files: [...declaredFiles(WINDOWS_X64_FIXTURE), "conpty"] })), "not-regular");
		} finally {
			cleanup();
		}
	});

	test("empty-file: a declared regular file has zero bytes", () => {
		const { root, cleanup } = materializeFixture(LINUX_X64_FIXTURE, [{ path: "empty.bin", contents: "" }]);
		try {
			expectManifestError(() => generateManifest(inputFor(LINUX_X64_FIXTURE, root, { files: [...declaredFiles(LINUX_X64_FIXTURE), "empty.bin"] })), "empty-file");
		} finally {
			cleanup();
		}
	});

	test("no-files: an empty declared list", () => {
		const { root, cleanup } = materializeFixture(LINUX_X64_FIXTURE);
		try {
			expectManifestError(() => generateManifest(inputFor(LINUX_X64_FIXTURE, root, { files: [] })), "no-files");
		} finally {
			cleanup();
		}
	});

	test("invalid-entrypoint: entrypoint not among declared files", () => {
		const { root, cleanup } = materializeFixture(LINUX_X64_FIXTURE);
		try {
			expectManifestError(() => generateManifest(inputFor(LINUX_X64_FIXTURE, root, { entrypoint: "not-declared.js" })), "invalid-entrypoint");
		} finally {
			cleanup();
		}
	});

	test("invalid-metadata: bad os, non-positive protocol, or blank version", () => {
		const cases: ManifestMetadata[] = [
			{ ...LINUX_X64_FIXTURE.metadata, os: "windows" as ManifestMetadata["os"] },
			{ ...LINUX_X64_FIXTURE.metadata, arch: "aarch64" as ManifestMetadata["arch"] },
			{ ...LINUX_X64_FIXTURE.metadata, protocolVersion: 0 },
			{ ...LINUX_X64_FIXTURE.metadata, protocolVersion: 1.5 },
			{ ...LINUX_X64_FIXTURE.metadata, hostVersion: "" },
			{ ...LINUX_X64_FIXTURE.metadata, bunVersion: "  " },
		];
		for (const metadata of cases) {
			expectManifestError(() => generateManifest(inputFor(LINUX_X64_FIXTURE, "unused", { metadata })), "invalid-metadata");
		}
	});
});

describe("rejections — validation", () => {
	test("incompatible-schema: bad JSON, wrong version, malformed shape", () => {
		expectManifestError(() => parseManifest("}not json{"), "incompatible-schema");
		expectManifestError(() => parseManifest({ manifestSchemaVersion: 999 }), "incompatible-schema");
		expectManifestError(() => parseManifest([]), "incompatible-schema");
		expectManifestError(
			() => parseManifest({ manifestSchemaVersion: MANIFEST_SCHEMA_VERSION, hostVersion: 1, protocolVersion: "x", bunVersion: "1", os: "linux", arch: "x64", entrypoint: "a", files: [] }),
			"incompatible-schema",
		);
	});

	test("checksum-mismatch: file bytes changed after the manifest was written", () => {
		const { root, cleanup } = materializeFixture(LINUX_X64_FIXTURE);
		try {
			const manifest = generateManifest(inputFor(LINUX_X64_FIXTURE, root));
			writeFileSync(join(root, "lib/libnative.so"), Buffer.from("tampered-bytes-different-length", "binary"));
			const err = expectManifestError(() => validateManifest(manifest, root), "checksum-mismatch");
			expect(err.detail.path).toBe("lib/libnative.so");
		} finally {
			cleanup();
		}
	});

	test("partial: a declared file was deleted after the manifest was written", () => {
		const { root, cleanup } = materializeFixture(MACOS_ARM64_FIXTURE);
		try {
			const manifest = generateManifest(inputFor(MACOS_ARM64_FIXTURE, root));
			// Re-validate against a fresh root missing one file.
			const bare = materializeFixture({ ...MACOS_ARM64_FIXTURE, files: MACOS_ARM64_FIXTURE.files.slice(0, 1) });
			try {
				expectManifestError(() => validateManifest(manifest, bare.root), "partial");
			} finally {
				bare.cleanup();
			}
		} finally {
			cleanup();
		}
	});

	test("missing: validating against an absent root", () => {
		const { root, cleanup } = materializeFixture(LINUX_X64_FIXTURE);
		try {
			const manifest = generateManifest(inputFor(LINUX_X64_FIXTURE, root));
			expectManifestError(() => validateManifest(manifest, join(root, "nope")), "missing");
		} finally {
			cleanup();
		}
	});
});
