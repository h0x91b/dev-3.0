import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { symlinkOnWritePath } from "../../shared/symlink-write-guard";

describe("symlinkOnWritePath", () => {
	let root: string;
	let outside: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dev3-guard-root-"));
		outside = mkdtempSync(join(tmpdir(), "dev3-guard-outside-"));
		writeFileSync(join(outside, "settings.json"), "{}");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	it("is null for a path that does not exist yet", () => {
		expect(symlinkOnWritePath(root, join(root, ".claude", "settings.local.json"))).toBeNull();
	});

	it("is null for a plain file in a plain directory", () => {
		mkdirSync(join(root, ".claude"));
		writeFileSync(join(root, ".claude", "settings.local.json"), "{}");
		expect(symlinkOnWritePath(root, join(root, ".claude", "settings.local.json"))).toBeNull();
	});

	it("names a symlinked file", () => {
		mkdirSync(join(root, ".claude"));
		const link = join(root, ".claude", "settings.local.json");
		symlinkSync(join(outside, "settings.json"), link);
		expect(symlinkOnWritePath(root, link)).toBe(link);
	});

	it("names a symlinked parent directory before the file", () => {
		symlinkSync(outside, join(root, ".claude"));
		expect(symlinkOnWritePath(root, join(root, ".claude", "settings.json"))).toBe(join(root, ".claude"));
	});

	it("allows a link that stays inside the root", () => {
		mkdirSync(join(root, "config"));
		symlinkSync(join(root, "config"), join(root, ".claude"));
		expect(symlinkOnWritePath(root, join(root, ".claude", "settings.local.json"))).toBeNull();
	});

	it("allows a relative link that stays inside the root", () => {
		mkdirSync(join(root, "config"));
		symlinkSync("config", join(root, ".claude"));
		expect(symlinkOnWritePath(root, join(root, ".claude", "settings.local.json"))).toBeNull();
	});

	it("names a link that climbs out of the root through a relative path", () => {
		const link = join(root, ".claude");
		symlinkSync(`../${outside.split("/").pop()}`, link);
		expect(symlinkOnWritePath(root, join(link, "settings.json"))).toBe(link);
	});

	it("names a link pointing back at the root itself", () => {
		const link = join(root, ".claude");
		symlinkSync(root, link);
		expect(symlinkOnWritePath(root, join(link, "settings.json"))).toBe(link);
	});

	it("names a dangling link", () => {
		const link = join(root, ".claude");
		symlinkSync(join(root, "missing"), link);
		expect(symlinkOnWritePath(root, join(link, "settings.json"))).toBe(link);
	});

	it("does not inspect the root itself", () => {
		const linkedRoot = join(outside, "linked-root");
		symlinkSync(root, linkedRoot);
		expect(symlinkOnWritePath(linkedRoot, join(linkedRoot, ".claude", "x.json"))).toBeNull();
	});

	it("is null for a target outside the root", () => {
		expect(symlinkOnWritePath(root, join(outside, "settings.json"))).toBeNull();
	});
});
