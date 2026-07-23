import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selectImageByTag, selectImageForProtocol } from "../rollback";
import { fingerprintImage, stageHostImage } from "../staging";

const STAGED_AT = "2026-07-23T00:00:00.000Z";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dev3-host-images-rollback-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("explicit rollback selection", () => {
	it("selects the single image that speaks the requested protocol version", () => {
		stageHostImage(root, { tag: "host-v1", protocolVersion: 1, stagedAt: STAGED_AT });
		stageHostImage(root, { tag: "host-v2", protocolVersion: 2, stagedAt: STAGED_AT });
		const selection = selectImageForProtocol(root, 1);
		expect(selection).toMatchObject({ status: "selected", tag: "host-v1", protocolVersion: 1 });
	});

	it("never guesses when no image is compatible — reports what IS available, no fallback to newest", () => {
		stageHostImage(root, { tag: "host-v1", protocolVersion: 1, stagedAt: STAGED_AT });
		stageHostImage(root, { tag: "host-v2", protocolVersion: 2, stagedAt: STAGED_AT });
		const selection = selectImageForProtocol(root, 3);
		expect(selection).toEqual({ status: "no-compatible-image", protocolVersion: 3, availableProtocolVersions: [1, 2] });
	});

	it("refuses to silently pick one of several images at the same version (ambiguous)", () => {
		stageHostImage(root, { tag: "host-v1", protocolVersion: 1, stagedAt: STAGED_AT });
		stageHostImage(root, { tag: "host-v1-hotfix", protocolVersion: 1, stagedAt: STAGED_AT });
		const selection = selectImageForProtocol(root, 1);
		expect(selection).toEqual({ status: "ambiguous", protocolVersion: 1, tags: ["host-v1", "host-v1-hotfix"] });
	});

	it("selection is read-only — it mutates no manifest or metadata", () => {
		stageHostImage(root, { tag: "host-v1", protocolVersion: 1, stagedAt: STAGED_AT });
		stageHostImage(root, { tag: "host-v2", protocolVersion: 2, stagedAt: STAGED_AT });
		const before = { v1: fingerprintImage(root, "host-v1"), v2: fingerprintImage(root, "host-v2") };
		selectImageForProtocol(root, 1);
		selectImageForProtocol(root, 3);
		selectImageByTag(root, "host-v2");
		const after = { v1: fingerprintImage(root, "host-v1"), v2: fingerprintImage(root, "host-v2") };
		expect(after).toEqual(before);
	});

	it("selects by exact tag and reports not-found honestly", () => {
		stageHostImage(root, { tag: "host-v1", protocolVersion: 1, stagedAt: STAGED_AT });
		expect(selectImageByTag(root, "host-v1")).toMatchObject({ status: "selected", tag: "host-v1" });
		expect(selectImageByTag(root, "ghost")).toEqual({ status: "not-found", tag: "ghost" });
	});

	it("no-compatible-image on an empty staging root, still no fallback", () => {
		expect(selectImageForProtocol(root, 1)).toEqual({ status: "no-compatible-image", protocolVersion: 1, availableProtocolVersions: [] });
	});
});
