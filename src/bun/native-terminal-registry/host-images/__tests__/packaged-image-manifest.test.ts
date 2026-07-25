/**
 * Merged packaged-host-image manifest: byte-stable serialization, strict parsing,
 * and every typed rejection the file table alone cannot express.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManifestError } from "../artifact-manifest";
import {
	buildPackagedHostImageManifest,
	packagedHostImageTag,
	parsePackagedHostImageManifest,
	serializePackagedHostImageManifest,
	validatePackagedHostImageManifest,
	PACKAGED_HOST_IMAGE_SCHEMA_VERSION,
	type BuildPackagedHostImageManifestInput,
} from "../packaged-image-manifest";

let imageRoot: string;

const CARRIER = "dev3-terminal-host.exe";
const ENTRYPOINT = "dev3-terminal-host.js";

beforeEach(() => {
	imageRoot = mkdtempSync(join(tmpdir(), "dev3-merged-manifest-"));
	writeFileSync(join(imageRoot, CARRIER), "bun-windows-runtime-x64");
	writeFileSync(join(imageRoot, ENTRYPOINT), "console.log('host');\n");
});

afterEach(() => {
	rmSync(imageRoot, { recursive: true, force: true });
});

function input(overrides: Partial<BuildPackagedHostImageManifestInput> = {}): BuildPackagedHostImageManifestInput {
	return {
		imageRoot,
		entrypoint: ENTRYPOINT,
		runtimeCarrier: CARRIER,
		files: [CARRIER, ENTRYPOINT],
		metadata: { hostVersion: "1.40.0", protocolVersion: 1, bunVersion: "1.3.14", os: "win32", arch: "x64" },
		runtimeFloor: "1.3.14",
		archiveParent: "native-host-image",
		...overrides,
	};
}

function expectCode(run: () => unknown, code: string): void {
	try {
		run();
	} catch (err) {
		expect(err).toBeInstanceOf(ManifestError);
		expect((err as ManifestError).code).toBe(code);
		return;
	}
	throw new Error(`expected a ${code} rejection`);
}

describe("buildPackagedHostImageManifest", () => {
	test("merges image identity, file table, and archive path", () => {
		const manifest = buildPackagedHostImageManifest(input());
		expect(manifest.imageSchemaVersion).toBe(PACKAGED_HOST_IMAGE_SCHEMA_VERSION);
		expect(manifest.archiveRoot).toBe(`native-host-image/${manifest.tag}`);
		expect(manifest.artifact.files).toHaveLength(2);
		expect(manifest.artifact.entrypoint).toBe(ENTRYPOINT);
	});

	test("the tag is derived from content, floor, and carrier", () => {
		const manifest = buildPackagedHostImageManifest(input());
		expect(manifest.tag).toBe(packagedHostImageTag(manifest.artifact, manifest.runtimeFloor, manifest.runtimeCarrier));
		expect(packagedHostImageTag(manifest.artifact, "1.3.15", manifest.runtimeCarrier)).not.toBe(manifest.tag);
	});

	test("serialization is byte-stable and round-trips", () => {
		const manifest = buildPackagedHostImageManifest(input());
		const text = serializePackagedHostImageManifest(manifest);
		expect(text.endsWith("\n")).toBe(true);
		expect(serializePackagedHostImageManifest(parsePackagedHostImageManifest(text))).toBe(text);
	});

	test("rejects a carrier that is not a declared file", () => {
		expectCode(() => buildPackagedHostImageManifest(input({ runtimeCarrier: "absent.exe" })), "invalid-runtime-carrier");
	});

	test("rejects a carrier that is also the entrypoint", () => {
		expectCode(() => buildPackagedHostImageManifest(input({ runtimeCarrier: ENTRYPOINT })), "invalid-runtime-carrier");
	});

	test("rejects a blank runtime floor", () => {
		expectCode(() => buildPackagedHostImageManifest(input({ runtimeFloor: "  " })), "invalid-metadata");
	});

	test("rejects a packaged Bun below the runtime floor", () => {
		expectCode(() => buildPackagedHostImageManifest(input({ runtimeFloor: "1.4.0" })), "runtime-floor");
	});
});

describe("parsePackagedHostImageManifest", () => {
	test("rejects a foreign schema version", () => {
		expectCode(() => parsePackagedHostImageManifest({ imageSchemaVersion: 99 }), "incompatible-schema");
	});

	test("rejects invalid JSON and non-objects", () => {
		expectCode(() => parsePackagedHostImageManifest("{ not json"), "incompatible-schema");
		expectCode(() => parsePackagedHostImageManifest([]), "incompatible-schema");
	});

	test("rejects a manifest missing merged fields", () => {
		const manifest = buildPackagedHostImageManifest(input());
		const raw = JSON.parse(serializePackagedHostImageManifest(manifest));
		delete raw.runtimeCarrier;
		expectCode(() => parsePackagedHostImageManifest(raw), "incompatible-schema");
	});
});

describe("validatePackagedHostImageManifest", () => {
	function serialized(overrides: (raw: Record<string, unknown>) => void = () => {}): string {
		const raw = JSON.parse(serializePackagedHostImageManifest(buildPackagedHostImageManifest(input())));
		overrides(raw);
		return JSON.stringify(raw);
	}

	test("accepts the manifest it just wrote", () => {
		const manifest = validatePackagedHostImageManifest(serialized(), imageRoot, {
			os: "win32",
			arch: "x64",
			bunVersion: "1.3.14",
			protocolVersion: 1,
			archiveParent: "native-host-image",
		});
		expect(manifest.artifact.files).toHaveLength(2);
	});

	test("rejects a recorded size that no longer matches the bytes", () => {
		expectCode(
			() =>
				validatePackagedHostImageManifest(
					serialized((raw) => {
						const artifact = raw.artifact as { files: Array<{ size: number }> };
						artifact.files[0].size += 1;
					}),
					imageRoot,
				),
			"checksum-mismatch",
		);
	});

	test("rejects an archive root that does not end in the image tag", () => {
		expectCode(
			() => validatePackagedHostImageManifest(serialized((raw) => void (raw.archiveRoot = "native-host-image/other")), imageRoot),
			"invalid-archive-root",
		);
	});

	test("rejects an archive root under a different parent than expected", () => {
		expectCode(
			() => validatePackagedHostImageManifest(serialized(), imageRoot, { archiveParent: "somewhere-else" }),
			"invalid-archive-root",
		);
	});

	test("rejects an unsafe tag", () => {
		expectCode(() => validatePackagedHostImageManifest(serialized((raw) => void (raw.tag = "../escape")), imageRoot), "invalid-tag");
	});

	test("rejects a mismatched OS, arch, Bun version, protocol version, or tag", () => {
		for (const expectations of [
			{ os: "linux" as const },
			{ arch: "arm64" as const },
			{ bunVersion: "1.9.9" },
			{ protocolVersion: 42 },
			{ tag: "1.3.14-p1-000000000000" },
		]) {
			expectCode(() => validatePackagedHostImageManifest(serialized(), imageRoot, expectations), "unexpected-target");
		}
	});

	test("rejects an image whose files moved out of the root", () => {
		const raw = serialized();
		const emptyRoot = mkdtempSync(join(tmpdir(), "dev3-merged-empty-"));
		mkdirSync(emptyRoot, { recursive: true });
		try {
			expectCode(() => validatePackagedHostImageManifest(raw, emptyRoot), "partial");
		} finally {
			rmSync(emptyRoot, { recursive: true, force: true });
		}
	});
});
