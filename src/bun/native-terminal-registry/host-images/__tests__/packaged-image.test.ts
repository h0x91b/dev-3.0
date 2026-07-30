/**
 * Packaged host image lifecycle: deterministic assembly, merged-manifest
 * validation, additive staging outside the install root, coexistence of an old
 * and a new image, and read-only rollback selection.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManifestError } from "../artifact-manifest";
import {
	assemblePackagedImage,
	discoverPackagedImage,
	fingerprintPackagedImage,
	isInsideDirectory,
	listPackagedImages,
	PACKAGED_HOST_ENTRYPOINT,
	PACKAGED_HOST_IMAGE_PARENT,
	packagedHostRuntimeCarrier,
	readPackagedImage,
	selectPackagedImage,
	stagePackagedImage,
	type AssemblePackagedImageInput,
} from "../packaged-image";
import { PACKAGED_HOST_IMAGE_MANIFEST_FILE } from "../packaged-image-manifest";

let workspace: string;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "dev3-packaged-image-"));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

interface SourceFiles {
	runtimeSourcePath: string;
	entrypointSourcePath: string;
}

function writeSources(name: string, runtimeBytes = "bun-windows-runtime-x64", entrypointBytes = "console.log('host');\n"): SourceFiles {
	const dir = join(workspace, "sources", name);
	mkdirSync(dir, { recursive: true });
	const runtimeSourcePath = join(dir, "bun.exe");
	const entrypointSourcePath = join(dir, PACKAGED_HOST_ENTRYPOINT);
	writeFileSync(runtimeSourcePath, runtimeBytes);
	writeFileSync(entrypointSourcePath, entrypointBytes);
	return { runtimeSourcePath, entrypointSourcePath };
}

function assembleInput(packageRoot: string, sources: SourceFiles, overrides: Partial<AssemblePackagedImageInput> = {}): AssemblePackagedImageInput {
	return {
		packageRoot,
		runtimeSourcePath: sources.runtimeSourcePath,
		entrypointSourcePath: sources.entrypointSourcePath,
		hostVersion: "1.40.0",
		protocolVersion: 1,
		bunVersion: "1.3.14",
		runtimeFloor: "1.3.14",
		os: "win32",
		arch: "x64",
		...overrides,
	};
}

function newPackageRoot(name: string): string {
	const root = join(workspace, "packages", name);
	mkdirSync(root, { recursive: true });
	return root;
}

describe("assemblePackagedImage", () => {
	test("assembles a self-describing image and records its archive path", () => {
		const packageRoot = newPackageRoot("app");
		const image = assemblePackagedImage(assembleInput(packageRoot, writeSources("a")));

		expect(image.reused).toBe(false);
		expect(image.tag.startsWith("1.3.14-p1-")).toBe(true);
		expect(image.manifest.archiveRoot).toBe(`${PACKAGED_HOST_IMAGE_PARENT}/${image.tag}`);
		expect(image.manifest.runtimeCarrier).toBe("dev3-terminal-host.exe");
		expect(image.manifest.artifact.entrypoint).toBe(PACKAGED_HOST_ENTRYPOINT);
		expect(existsSync(image.entrypointPath)).toBe(true);
		expect(existsSync(image.runtimeCarrierPath)).toBe(true);
		expect(image.manifest.artifact.files.map((entry) => entry.path).sort()).toEqual(
			[PACKAGED_HOST_ENTRYPOINT, "dev3-terminal-host.exe"].sort(),
		);
	});

	test("identical inputs yield the identical tag and byte-identical manifest", () => {
		const sources = writeSources("same");
		const first = assemblePackagedImage(assembleInput(newPackageRoot("one"), sources));
		const second = assemblePackagedImage(assembleInput(newPackageRoot("two"), sources));

		expect(second.tag).toBe(first.tag);
		expect(readFileSync(second.manifestPath, "utf8")).toBe(readFileSync(first.manifestPath, "utf8"));
	});

	test("changed entrypoint bytes yield a different tag", () => {
		const first = assemblePackagedImage(assembleInput(newPackageRoot("v1"), writeSources("v1", "runtime", "// v1\n")));
		const second = assemblePackagedImage(assembleInput(newPackageRoot("v2"), writeSources("v2", "runtime", "// v2\n")));
		expect(second.tag).not.toBe(first.tag);
	});

	test("re-assembling into the same package reuses the existing image untouched", () => {
		const packageRoot = newPackageRoot("idempotent");
		const sources = writeSources("idem");
		const first = assemblePackagedImage(assembleInput(packageRoot, sources));
		const before = fingerprintPackagedImage(first.imageDir);

		const second = assemblePackagedImage(assembleInput(packageRoot, sources));
		expect(second.reused).toBe(true);
		expect(second.tag).toBe(first.tag);
		expect(fingerprintPackagedImage(second.imageDir)).toBe(before);
		expect(readdirSync(join(packageRoot, PACKAGED_HOST_IMAGE_PARENT))).toEqual([first.tag]);
	});

	test("rejects a Bun version below the declared runtime floor", () => {
		expect(() =>
			assemblePackagedImage(assembleInput(newPackageRoot("floor"), writeSources("floor"), { bunVersion: "1.3.13" })),
		).toThrowError(ManifestError);
	});

	test("leaves no scratch directory behind", () => {
		const packageRoot = newPackageRoot("clean");
		const image = assemblePackagedImage(assembleInput(packageRoot, writeSources("clean")));
		expect(readdirSync(join(packageRoot, PACKAGED_HOST_IMAGE_PARENT))).toEqual([image.tag]);
	});
});

describe("readPackagedImage", () => {
	test("detects a tampered file as a checksum mismatch", () => {
		const image = assemblePackagedImage(assembleInput(newPackageRoot("tamper"), writeSources("tamper")));
		writeFileSync(image.entrypointPath, "console.log('tampered');\n");

		const read = readPackagedImage(image.imageDir);
		expect(read.status).toBe("partial");
		if (read.status === "partial") expect(read.code).toBe("checksum-mismatch");
	});

	test("detects a removed file as a partial image", () => {
		const image = assemblePackagedImage(assembleInput(newPackageRoot("gone"), writeSources("gone")));
		rmSync(image.runtimeCarrierPath);

		const read = readPackagedImage(image.imageDir);
		expect(read.status).toBe("partial");
		if (read.status === "partial") expect(read.code).toBe("partial");
	});

	test("detects a missing manifest as a partial image", () => {
		const image = assemblePackagedImage(assembleInput(newPackageRoot("nomanifest"), writeSources("nomanifest")));
		rmSync(image.manifestPath);

		const read = readPackagedImage(image.imageDir);
		expect(read.status).toBe("partial");
		if (read.status === "partial") expect(read.reason).toContain(PACKAGED_HOST_IMAGE_MANIFEST_FILE);
	});

	test("reports an absent directory rather than throwing", () => {
		expect(readPackagedImage(join(workspace, "nowhere")).status).toBe("absent");
	});

	test("rejects a manifest that contradicts the caller's expectations", () => {
		const image = assemblePackagedImage(assembleInput(newPackageRoot("expect"), writeSources("expect")));

		const wrongArch = readPackagedImage(image.imageDir, { arch: "arm64" });
		expect(wrongArch.status).toBe("partial");
		if (wrongArch.status === "partial") expect(wrongArch.code).toBe("unexpected-target");

		const wrongProtocol = readPackagedImage(image.imageDir, { protocolVersion: 99 });
		if (wrongProtocol.status === "partial") expect(wrongProtocol.code).toBe("unexpected-target");
		expect(readPackagedImage(image.imageDir, { os: "win32", arch: "x64", bunVersion: "1.3.14" }).status).toBe("ok");
	});
});

describe("discoverPackagedImage", () => {
	test("finds the single image shipped inside a package", () => {
		const packageRoot = newPackageRoot("discover");
		const image = assemblePackagedImage(assembleInput(packageRoot, writeSources("discover")));

		const found = discoverPackagedImage(packageRoot, { os: "win32", arch: "x64" });
		expect(found.status).toBe("ok");
		if (found.status === "ok") expect(found.tag).toBe(image.tag);
	});

	test("names the missing build step when the package has no image at all", () => {
		const found = discoverPackagedImage(newPackageRoot("empty"));
		expect(found.status).toBe("absent");
		if (found.status === "absent") expect(found.reason).toContain("build:native");
	});

	test("refuses to guess between two images in one package", () => {
		const packageRoot = newPackageRoot("two-images");
		assemblePackagedImage(assembleInput(packageRoot, writeSources("i1", "runtime", "// one\n")));
		assemblePackagedImage(assembleInput(packageRoot, writeSources("i2", "runtime", "// two\n")));

		const found = discoverPackagedImage(packageRoot);
		expect(found.status).toBe("ambiguous");
		if (found.status === "ambiguous") expect(found.tags).toHaveLength(2);
	});

	test("reports a corrupt shipped image as partial", () => {
		const packageRoot = newPackageRoot("corrupt");
		const image = assemblePackagedImage(assembleInput(packageRoot, writeSources("corrupt")));
		writeFileSync(image.manifestPath, "{ not json");

		const found = discoverPackagedImage(packageRoot);
		expect(found.status).toBe("partial");
	});
});

describe("stagePackagedImage", () => {
	function stagingRoot(): string {
		return join(workspace, "staged");
	}

	test("stages the image outside the installation directory", () => {
		const packageRoot = newPackageRoot("stage");
		const image = assemblePackagedImage(assembleInput(packageRoot, writeSources("stage")));

		const result = stagePackagedImage({ sourceImageDir: image.imageDir, stagingRoot: stagingRoot() });
		expect(result.status).toBe("staged");
		if (result.status !== "staged") return;
		expect(isInsideDirectory(packageRoot, result.imageDir)).toBe(false);
		expect(existsSync(result.entrypointPath)).toBe(true);
		expect(existsSync(result.runtimeCarrierPath)).toBe(true);
		expect(fingerprintPackagedImage(result.imageDir)).toBe(fingerprintPackagedImage(image.imageDir));
	});

	test("never overwrites an already-staged image", () => {
		const image = assemblePackagedImage(assembleInput(newPackageRoot("again"), writeSources("again")));
		const first = stagePackagedImage({ sourceImageDir: image.imageDir, stagingRoot: stagingRoot() });
		expect(first.status).toBe("staged");
		if (first.status !== "staged") return;
		const fingerprint = fingerprintPackagedImage(first.imageDir);

		const second = stagePackagedImage({ sourceImageDir: image.imageDir, stagingRoot: stagingRoot() });
		expect(second.status).toBe("already-staged");
		expect(fingerprintPackagedImage(first.imageDir)).toBe(fingerprint);
	});

	test("an old image stays byte-identical and selectable while a new one is staged beside it", () => {
		const old = assemblePackagedImage(assembleInput(newPackageRoot("old"), writeSources("old", "runtime-old", "// old host\n")));
		const stagedOld = stagePackagedImage({ sourceImageDir: old.imageDir, stagingRoot: stagingRoot() });
		expect(stagedOld.status).toBe("staged");
		if (stagedOld.status !== "staged") return;
		const oldFingerprint = fingerprintPackagedImage(stagedOld.imageDir);

		const next = assemblePackagedImage(assembleInput(newPackageRoot("new"), writeSources("new", "runtime-new", "// new host\n")));
		const stagedNew = stagePackagedImage({ sourceImageDir: next.imageDir, stagingRoot: stagingRoot() });
		expect(stagedNew.status).toBe("staged");
		if (stagedNew.status !== "staged") return;

		expect(stagedNew.tag).not.toBe(stagedOld.tag);
		expect(fingerprintPackagedImage(stagedOld.imageDir)).toBe(oldFingerprint);
		expect(listPackagedImages(stagingRoot()).ok.map((entry) => entry.tag).sort()).toEqual([stagedOld.tag, stagedNew.tag].sort());

		const rolledBack = selectPackagedImage(stagingRoot(), { tag: stagedOld.tag });
		expect(rolledBack.status).toBe("selected");
		if (rolledBack.status === "selected") {
			expect(rolledBack.entrypointPath).toBe(stagedOld.entrypointPath);
			expect(fingerprintPackagedImage(rolledBack.imageDir)).toBe(oldFingerprint);
		}
	});

	test("refuses to stage a corrupt source and leaves nothing visible", () => {
		const image = assemblePackagedImage(assembleInput(newPackageRoot("badsource"), writeSources("badsource")));
		writeFileSync(image.entrypointPath, "console.log('tampered');\n");

		const result = stagePackagedImage({ sourceImageDir: image.imageDir, stagingRoot: stagingRoot() });
		expect(result.status).toBe("failed");
		expect(listPackagedImages(stagingRoot()).ok).toHaveLength(0);
	});

	test("reports an already-staged image that went corrupt instead of rewriting it", () => {
		const image = assemblePackagedImage(assembleInput(newPackageRoot("corruptdest"), writeSources("corruptdest")));
		const first = stagePackagedImage({ sourceImageDir: image.imageDir, stagingRoot: stagingRoot() });
		if (first.status !== "staged") throw new Error("expected the first staging to succeed");
		rmSync(first.runtimeCarrierPath);

		const second = stagePackagedImage({ sourceImageDir: image.imageDir, stagingRoot: stagingRoot() });
		expect(second.status).toBe("failed");
		if (second.status === "failed") expect(second.reason).toContain("never overwritten");
		expect(existsSync(first.runtimeCarrierPath)).toBe(false);
	});

	test("ignores its own scratch directories when listing staged images", () => {
		mkdirSync(join(stagingRoot(), ".staging-leftover"), { recursive: true });
		expect(listPackagedImages(stagingRoot()).ok).toHaveLength(0);
		expect(listPackagedImages(stagingRoot()).incomplete).toHaveLength(0);
	});
});

describe("selectPackagedImage", () => {
	test("selects by protocol version and reports what is available otherwise", () => {
		const stagingRoot = join(workspace, "rollback");
		const image = assemblePackagedImage(assembleInput(newPackageRoot("sel"), writeSources("sel")));
		const staged = stagePackagedImage({ sourceImageDir: image.imageDir, stagingRoot });
		if (staged.status !== "staged") throw new Error("expected staging to succeed");

		const byProtocol = selectPackagedImage(stagingRoot, { protocolVersion: 1 });
		expect(byProtocol.status).toBe("selected");
		if (byProtocol.status === "selected") expect(byProtocol.tag).toBe(staged.tag);

		const missing = selectPackagedImage(stagingRoot, { protocolVersion: 7 });
		expect(missing.status).toBe("not-found");
		if (missing.status === "not-found") {
			expect(missing.availableProtocolVersions).toEqual([1]);
			expect(missing.availableTags).toEqual([staged.tag]);
		}
		expect(selectPackagedImage(stagingRoot, {}).status).toBe("not-found");
		expect(selectPackagedImage(stagingRoot, { tag: "1.3.14-p1-deadbeefcafe" }).status).toBe("not-found");
	});

	test("refuses to pick between two images speaking the same protocol version", () => {
		const stagingRoot = join(workspace, "ambiguous");
		for (const variant of ["a", "b"]) {
			const image = assemblePackagedImage(assembleInput(newPackageRoot(`amb-${variant}`), writeSources(`amb-${variant}`, "runtime", `// ${variant}\n`)));
			stagePackagedImage({ sourceImageDir: image.imageDir, stagingRoot });
		}
		const selection = selectPackagedImage(stagingRoot, { protocolVersion: 1 });
		expect(selection.status).toBe("ambiguous");
		if (selection.status === "ambiguous") expect(selection.tags).toHaveLength(2);
	});
});

describe("cross-platform images", () => {
	test("the runtime carrier is extensionless everywhere except Windows", () => {
		expect(packagedHostRuntimeCarrier("win32")).toBe("dev3-terminal-host.exe");
		expect(packagedHostRuntimeCarrier("darwin")).toBe("dev3-terminal-host");
		expect(packagedHostRuntimeCarrier("linux")).toBe("dev3-terminal-host");
	});

	test.each([
		["darwin", "arm64"],
		["linux", "x64"],
	] as const)("assembles and discovers a %s/%s image", (os, arch) => {
		const packageRoot = newPackageRoot(`${os}-${arch}`);
		const image = assemblePackagedImage(assembleInput(packageRoot, writeSources(`${os}-${arch}`), { os, arch }));

		expect(image.manifest.runtimeCarrier).toBe("dev3-terminal-host");
		expect(image.manifest.artifact.os).toBe(os);
		expect(image.manifest.artifact.files.map((entry) => entry.path).sort()).toEqual(
			[PACKAGED_HOST_ENTRYPOINT, "dev3-terminal-host"].sort(),
		);

		const discovered = discoverPackagedImage(packageRoot, { os, arch, archiveParent: PACKAGED_HOST_IMAGE_PARENT });
		expect(discovered.status).toBe("ok");
		if (discovered.status === "ok") expect(discovered.tag).toBe(image.tag);
	});

	test("an image built for another OS is rejected rather than adapted", () => {
		const packageRoot = newPackageRoot("wrong-os");
		assemblePackagedImage(assembleInput(packageRoot, writeSources("wrong-os"), { os: "darwin", arch: "arm64" }));

		const discovered = discoverPackagedImage(packageRoot, { os: "linux", arch: "arm64" });
		expect(discovered.status).toBe("partial");
		if (discovered.status === "partial") expect(discovered.reason).toMatch(/os is darwin, expected linux/);
	});

	test("the same bytes on two platforms are two different images", () => {
		const sources = writeSources("shared-bytes");
		const mac = assemblePackagedImage(assembleInput(newPackageRoot("m"), sources, { os: "darwin", arch: "arm64" }));
		const win = assemblePackagedImage(assembleInput(newPackageRoot("w"), sources, { os: "win32", arch: "arm64" }));
		expect(mac.tag).not.toBe(win.tag);
	});
});
