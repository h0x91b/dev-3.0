import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isValidImageTag, parseManifest, serializeManifest, type StagedHostImageManifest } from "../image-manifest";
import {
	fingerprintImage,
	HostImageAlreadyStagedError,
	imageDir,
	isPathInside,
	listStagedImages,
	manifestPath,
	readStagedImage,
	stageHostImage,
} from "../staging";

const STAGED_AT = "2026-07-23T00:00:00.000Z";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dev3-host-images-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("staged host image manifest", () => {
	it("round-trips a manifest", () => {
		const manifest: StagedHostImageManifest = {
			imageSchemaVersion: 1,
			tag: "host-v1",
			protocolVersion: 1,
			hostArtifactVersion: "1",
			entrypoint: "entrypoint.mjs",
			runtimeFloor: "1.3.14",
			stagedAt: STAGED_AT,
		};
		expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
	});

	it("rejects a foreign schema, corrupt json, and bad fields (unreadable-and-not-ours)", () => {
		expect(parseManifest("{not json")).toBeNull();
		expect(parseManifest(JSON.stringify({ imageSchemaVersion: 2, tag: "x", protocolVersion: 1 }))).toBeNull();
		expect(parseManifest(JSON.stringify({ imageSchemaVersion: 1, tag: "x", protocolVersion: 0, hostArtifactVersion: "1", entrypoint: "e", runtimeFloor: "1", stagedAt: STAGED_AT }))).toBeNull();
	});

	it("validates image tags", () => {
		expect(isValidImageTag("host-v1")).toBe(true);
		expect(isValidImageTag("../escape")).toBe(false);
		expect(isValidImageTag("a/b")).toBe(false);
		expect(isValidImageTag(".hidden")).toBe(false);
	});
});

describe("immutable staging", () => {
	it("stages an image with a manifest and a distinct entrypoint file", () => {
		const manifest = stageHostImage(root, { tag: "host-v1", protocolVersion: 1, stagedAt: STAGED_AT });
		expect(manifest.protocolVersion).toBe(1);
		expect(existsSync(manifestPath(root, "host-v1"))).toBe(true);
		expect(existsSync(join(imageDir(root, "host-v1"), manifest.entrypoint))).toBe(true);
		const shim = readFileSync(join(imageDir(root, "host-v1"), manifest.entrypoint), "utf8");
		expect(shim).toContain("protocolVersion=1");
		expect(shim).toContain("runStagedHost");
	});

	it("refuses to overwrite an already-staged image (no in-place executable replacement)", () => {
		stageHostImage(root, { tag: "host-v1", protocolVersion: 1, stagedAt: STAGED_AT });
		expect(() => stageHostImage(root, { tag: "host-v1", protocolVersion: 9, stagedAt: STAGED_AT })).toThrow(HostImageAlreadyStagedError);
	});

	it("stages two distinct images side by side; staging the second never rewrites the first", () => {
		stageHostImage(root, { tag: "host-v1", protocolVersion: 1, stagedAt: STAGED_AT });
		const before = fingerprintImage(root, "host-v1");
		stageHostImage(root, { tag: "host-v2", protocolVersion: 2, stagedAt: STAGED_AT });
		const after = fingerprintImage(root, "host-v1");
		expect(before).not.toBeNull();
		expect(after).toBe(before); // v1 image byte-identical after v2 was staged
		const v1Shim = readFileSync(join(imageDir(root, "host-v1"), "entrypoint.mjs"), "utf8");
		const v2Shim = readFileSync(join(imageDir(root, "host-v2"), "entrypoint.mjs"), "utf8");
		expect(v1Shim).not.toBe(v2Shim); // genuinely distinct launch artifacts
	});
});

describe("honest read diagnostics", () => {
	it("reports a missing image", () => {
		expect(readStagedImage(root, "ghost")).toMatchObject({ status: "missing", tag: "ghost" });
	});

	it("reports partial staging when the manifest is absent", () => {
		mkdirSync(imageDir(root, "half"), { recursive: true });
		writeFileSync(join(imageDir(root, "half"), "entrypoint.mjs"), "// nothing");
		const result = readStagedImage(root, "half");
		expect(result).toMatchObject({ status: "partial", missing: ["image.json"] });
	});

	it("reports partial staging when the entrypoint is absent", () => {
		stageHostImage(root, { tag: "host-v1", protocolVersion: 1, stagedAt: STAGED_AT });
		rmSync(join(imageDir(root, "host-v1"), "entrypoint.mjs"));
		const result = readStagedImage(root, "host-v1");
		expect(result).toMatchObject({ status: "partial", missing: ["entrypoint.mjs"] });
	});

	it("reports partial staging when the manifest is corrupt", () => {
		mkdirSync(imageDir(root, "bad"), { recursive: true });
		writeFileSync(manifestPath(root, "bad"), "{not json");
		expect(readStagedImage(root, "bad")).toMatchObject({ status: "partial" });
	});

	it("lists ok and incomplete images without throwing", () => {
		stageHostImage(root, { tag: "host-v1", protocolVersion: 1, stagedAt: STAGED_AT });
		stageHostImage(root, { tag: "host-v2", protocolVersion: 2, stagedAt: STAGED_AT });
		mkdirSync(imageDir(root, "half"), { recursive: true });
		const { ok, incomplete } = listStagedImages(root);
		expect(ok.map((image) => image.tag).sort()).toEqual(["host-v1", "host-v2"]);
		expect(incomplete.map((image) => image.tag)).toEqual(["half"]);
	});

	it("fingerprint is null for an absent image", () => {
		expect(fingerprintImage(root, "ghost")).toBeNull();
	});
});

describe("entrypoint containment guard", () => {
	it("recognises a file directly inside a directory", () => {
		expect(isPathInside("/a/b", "/a/b/entrypoint.mjs")).toBe(true);
		expect(isPathInside("/a/b", "/a/c/entrypoint.mjs")).toBe(false);
	});
});
