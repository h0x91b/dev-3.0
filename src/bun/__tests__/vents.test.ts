import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// vents.ts derives its storage dir from process.env.HOME (via paths.ts) at
// import time, so we point HOME at a tmp dir BEFORE the dynamic import.
let addVent: typeof import("../vents").addVent;
let VENTS_DIR: string;
let tmpHome: string;
let originalHome: string | undefined;

const FIXED = new Date(2026, 5, 15, 14, 30); // 2026-06-15 14:30 local

beforeAll(async () => {
	originalHome = process.env.HOME;
	tmpHome = mkdtempSync(join(tmpdir(), "dev3-vents-"));
	process.env.HOME = tmpHome;
	const mod = await import("../vents");
	addVent = mod.addVent;
	VENTS_DIR = mod.VENTS_DIR;
});

afterAll(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	rmSync(tmpHome, { recursive: true, force: true });
});

describe("addVent", () => {
	it("writes one markdown file named by date + time + slug", () => {
		const res = addVent("CLI is confusing", "The `dev3 vents` flags are unclear.", FIXED);
		expect(res.fileName).toBe("2026-06-15_14-30_cli-is-confusing.md");
		expect(res.path).toBe(`${VENTS_DIR}/2026-06-15_14-30_cli-is-confusing.md`);

		const body = readFileSync(res.path, "utf-8");
		expect(body).toContain("# CLI is confusing");
		expect(body).toContain("_2026-06-15 14:30_");
		expect(body).toContain("The `dev3 vents` flags are unclear.");
	});

	it("contains only the supplied name/date/content — no enrichment", () => {
		const res = addVent("anon check", "just platform feedback", FIXED);
		const body = readFileSync(res.path, "utf-8");
		// Nothing about a project, path, task, or cwd should ever appear.
		expect(body).not.toMatch(/projectId|taskId|worktree|\/Users\/|cwd/i);
		expect(body.trim()).toBe("# anon check\n\n_2026-06-15 14:30_\n\njust platform feedback".trim());
	});

	it("disambiguates same-minute collisions with a numeric suffix", () => {
		const a = addVent("dup name", "first", FIXED);
		const b = addVent("dup name", "second", FIXED);
		const c = addVent("dup name", "third", FIXED);
		expect(a.fileName).toBe("2026-06-15_14-30_dup-name.md");
		expect(b.fileName).toBe("2026-06-15_14-30_dup-name-2.md");
		expect(c.fileName).toBe("2026-06-15_14-30_dup-name-3.md");
	});

	it("slugifies non-ascii / punctuation names to ascii kebab", () => {
		const res = addVent("Tmux: split — broken?!", "x", FIXED);
		expect(res.fileName).toBe("2026-06-15_14-30_tmux-split-broken.md");
	});

	it("falls back to 'vent' slug when name has no usable chars", () => {
		const res = addVent("!!!", "x", FIXED);
		expect(res.fileName).toBe("2026-06-15_14-30_vent.md");
	});

	it("caps oversized content and name", () => {
		const hugeName = "n".repeat(500);
		const hugeContent = "c".repeat(20000);
		const res = addVent(hugeName, hugeContent, FIXED);
		const body = readFileSync(res.path, "utf-8");
		expect(body.length).toBeLessThan(9000);
		// name slug is capped to 60 chars
		expect(res.fileName.replace("2026-06-15_14-30_", "").replace(".md", "").length).toBeLessThanOrEqual(60);
	});

	it("creates the vents directory if missing", () => {
		addVent("dir check", "x", FIXED);
		const files = readdirSync(VENTS_DIR);
		expect(files.length).toBeGreaterThan(0);
	});
});
