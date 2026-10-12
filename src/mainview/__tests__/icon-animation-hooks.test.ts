import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Cascade invariants behind the animated icon families (tmx-/gtx-/hdr-/th-).
 * happy-dom never runs the real stylesheet, so a hook class with no rule, a
 * keyframe nobody plays, or a trigger that forgets keyboard focus only shows up
 * as an icon that silently stands still — they are asserted against the source.
 */
const SRC = path.resolve(__dirname, "..");
const CSS = readFileSync(path.join(SRC, "index.css"), "utf8");

const FAMILIES = [
	{ host: "tmux-anim", prefix: "tmx" },
	{ host: "git-anim", prefix: "gtx" },
	{ host: "header-anim", prefix: "hdr" },
	{ host: "task-anim", prefix: "th" },
] as const;

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (entry === "node_modules" || entry === "__tests__") continue;
			walk(full, out);
		} else if (entry.endsWith(".tsx")) {
			out.push(full);
		}
	}
	return out;
}

const TSX = walk(SRC).map((file) => readFileSync(file, "utf8")).join("\n");

describe("animated icon families", () => {
	it.each(FAMILIES)("$host triggers on keyboard focus as well as hover", ({ host }) => {
		expect(CSS).not.toMatch(new RegExp(`\\.${host}:hover \\.`));
		expect(CSS).toContain(`.${host}:is(:hover, :focus-visible) .`);
	});

	it.each(FAMILIES)("every $prefix- hook class used in a component has a rule", ({ prefix }) => {
		const used = new Set(TSX.match(new RegExp(`\\b${prefix}-[a-z0-9-]+`, "g")) ?? []);
		const styled = new Set((CSS.match(new RegExp(`\\.${prefix}-[a-z0-9-]+`, "g")) ?? []).map((c) => c.slice(1)));
		expect([...used].filter((c) => !styled.has(c))).toEqual([]);
	});

	it.each(FAMILIES)("every $prefix- rule targets a class some component renders", ({ prefix }) => {
		const used = new Set(TSX.match(new RegExp(`\\b${prefix}-[a-z0-9-]+`, "g")) ?? []);
		const styled = new Set((CSS.match(new RegExp(`\\.${prefix}-[a-z0-9-]+`, "g")) ?? []).map((c) => c.slice(1)));
		expect([...styled].filter((c) => !used.has(c))).toEqual([]);
	});

	it.each(FAMILIES)("every $prefix- keyframe is played by some rule", ({ prefix }) => {
		const defined = [...CSS.matchAll(new RegExp(`@keyframes (${prefix}-[a-z0-9-]+)`, "g"))].map((m) => m[1]);
		expect(defined.length).toBeGreaterThan(0);
		const unplayed = defined.filter((name) => !new RegExp(`animation:\\s*${name}\\s`).test(CSS));
		expect(unplayed).toEqual([]);
	});

	it.each(FAMILIES)("$host stops under prefers-reduced-motion", ({ host, prefix }) => {
		expect(CSS).toMatch(
			new RegExp(`prefers-reduced-motion: reduce\\)\\s*\\{[^}]*\\.${host}:is\\(:hover, :focus-visible\\) \\[class\\^="${prefix}-"\\][^}]*animation: none`),
		);
	});

	it("plays the act once on focus and on touch, authored after every family rule", () => {
		const focusOnce = CSS.indexOf(".tmux-anim:focus-visible:not(:hover)");
		const touchOnce = CSS.indexOf("@media (hover: none) {\n\t.tmux-anim:hover");
		expect(focusOnce).toBeGreaterThan(-1);
		expect(touchOnce).toBeGreaterThan(-1);
		// The touch override ties the per-icon rules on specificity, so it only wins
		// while it comes later in the file.
		const lastFamilyRule = Math.max(...FAMILIES.map(({ host }) => CSS.lastIndexOf(`.${host}:is(:hover, :focus-visible) .`)));
		expect(touchOnce).toBeGreaterThan(lastFamilyRule);
		for (const { host, prefix } of FAMILIES) {
			const block = CSS.slice(touchOnce, CSS.indexOf("}\n}", touchOnce));
			expect(block).toContain(`[class^="${prefix}-"]`);
			expect(block).toContain(`.${host}`);
		}
	});

	it("keeps state-driven loops out of the play-once overrides", () => {
		const overrides = CSS.slice(CSS.indexOf(".tmux-anim:focus-visible:not(:hover)"));
		expect(overrides).toContain(".header-anim:not(.remote-access-active, .hdr-rescan-busy):focus-visible");
		expect(overrides).toContain(".header-anim:not(.remote-access-active, .hdr-rescan-busy):hover");
	});
});
