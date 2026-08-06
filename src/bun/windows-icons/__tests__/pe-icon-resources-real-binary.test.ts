/**
 * The fixtures in `pe-fixture.ts` were written from the same reading of the PE
 * layout as the parser, so a shared misreading would pass both. This test breaks
 * that circle against a REAL Windows binary: `rcedit-x64.exe`, which our own
 * lockfile guarantees is present on every machine and every runner.
 *
 * It can only prove the negative direction — rcedit is a console tool with no
 * icon, and the repo carries no icon-bearing `.exe` to check the positive one.
 * Guarding against a false "icon found" is the direction that matters: a parser
 * that says yes to everything turns the whole proof into a rubber stamp.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { hasEmbeddedIcon, readResourceTypeIds } from "../pe-icon-resources";

const RT_VERSION = 16;
const RT_MANIFEST = 24;

const rceditExe = join(dirname(createRequire(import.meta.url).resolve("rcedit/package.json")), "bin", "rcedit-x64.exe");

describe("reading a real Windows executable", () => {
	const bytes = new Uint8Array(readFileSync(rceditExe));

	it("finds the resource types a real console tool carries", () => {
		expect(readResourceTypeIds(bytes)).toEqual([RT_VERSION, RT_MANIFEST]);
	});

	it("does not claim an icon that is not there", () => {
		expect(hasEmbeddedIcon(bytes)).toBe(false);
	});
});
