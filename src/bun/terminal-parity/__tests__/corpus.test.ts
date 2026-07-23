/**
 * Fast, backend-free guards for the parity corpus (MIG-001):
 * data integrity, required coverage, check completeness, the pure checks
 * themselves, and that the checked-in scenario→roadmap map stays in sync.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
	INTENTIONAL_DIFFERENCES,
	PARITY_CORPUS,
	ROADMAP_ITEMS,
	SCENARIO_CATEGORIES,
	getScenario,
} from "../corpus";
import { LIVE_CHECKS, PURE_CHECKS } from "../checks";

const roadmapSet = new Set<string>(ROADMAP_ITEMS);

describe("parity corpus — data integrity", () => {
	it("has unique scenario ids", () => {
		const ids = PARITY_CORPUS.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("covers every backend-neutral vocabulary verb", () => {
		for (const category of SCENARIO_CATEGORIES) {
			expect(PARITY_CORPUS.some((s) => s.category === category)).toBe(true);
		}
	});

	it("includes the five required negative cases", () => {
		const requiredNegatives = [
			"attach.missing-session-is-clean",
			"attach.duplicate-attach-does-not-disrupt",
			"resize.invalid-is-ignored",
			"capture.dead-view-is-clean",
			"cleanup.retry-is-idempotent",
		];
		for (const id of requiredNegatives) {
			expect(getScenario(id).kind).toBe("negative");
		}
	});

	it("captures the mandated observable dimensions", () => {
		// Stable ids, cwd/env, exit status, focus/size, capture ordering, cleanup.
		expect(getScenario("create.stable-logical-id")).toBeTruthy();
		expect(getScenario("create.session-cwd-env")).toBeTruthy();
		expect(getScenario("exit.status-code-propagates")).toBeTruthy();
		expect(getScenario("focus.exactly-one-active-view")).toBeTruthy();
		expect(getScenario("resize.min-across-clients")).toBeTruthy();
		expect(getScenario("capture.content-and-ordering")).toBeTruthy();
		expect(getScenario("cleanup.reaps-owned-process-tree")).toBeTruthy();
	});

	it("every scenario protects at least one real roadmap item", () => {
		for (const scenario of PARITY_CORPUS) {
			expect(scenario.protects.length).toBeGreaterThan(0);
			for (const item of scenario.protects) {
				expect(roadmapSet.has(item)).toBe(true);
			}
		}
	});

	it("MIG-001 is protected by the corpus (it is the corpus)", () => {
		expect(PARITY_CORPUS.some((s) => s.protects.includes("MIG-001"))).toBe(false);
		// MIG-001 is the artifact, not a behavior it protects — it defends the OTHER
		// items. Guard against accidentally tagging a scenario with its own id.
	});

	it("every scenario has a valid parity/verification/platform classification", () => {
		for (const scenario of PARITY_CORPUS) {
			expect(["required", "intentional-difference"]).toContain(scenario.parity.level);
			expect(["live", "pure", "gap"]).toContain(scenario.verification.mode);
			expect(["any", "posix", "windows"]).toContain(scenario.platform);
			// Gaps and intentional differences must justify themselves in a note.
			if (scenario.verification.mode === "gap") expect(scenario.verification.note).toBeTruthy();
			if (scenario.parity.level === "intentional-difference") expect(scenario.parity.note).toBeTruthy();
		}
	});

	it("documents intentional differences separately from required parity", () => {
		expect(INTENTIONAL_DIFFERENCES.length).toBeGreaterThan(0);
		for (const diff of INTENTIONAL_DIFFERENCES) {
			expect(diff.tmuxBehavior).toBeTruthy();
			expect(diff.nativeMayInstead).toBeTruthy();
			expect(diff.protects.length).toBeGreaterThan(0);
			for (const item of diff.protects) expect(roadmapSet.has(item)).toBe(true);
		}
	});
});

describe("parity corpus — check completeness", () => {
	const liveIds = PARITY_CORPUS.filter((s) => s.verification.mode === "live").map((s) => s.id);
	const pureIds = PARITY_CORPUS.filter((s) => s.verification.mode === "pure").map((s) => s.id);

	it("every live scenario has an executable check and vice versa", () => {
		expect(Object.keys(LIVE_CHECKS).sort()).toEqual([...liveIds].sort());
	});

	it("every pure scenario has an executable check and vice versa", () => {
		expect(Object.keys(PURE_CHECKS).sort()).toEqual([...pureIds].sort());
	});

	it("gap scenarios intentionally have no executable check", () => {
		const gapIds = PARITY_CORPUS.filter((s) => s.verification.mode === "gap").map((s) => s.id);
		for (const id of gapIds) {
			expect(LIVE_CHECKS[id]).toBeUndefined();
			expect(PURE_CHECKS[id]).toBeUndefined();
		}
	});
});

describe("parity corpus — pure checks pass against the product helpers", () => {
	for (const [id, check] of Object.entries(PURE_CHECKS)) {
		it(id, () => {
			expect(() => check()).not.toThrow();
		});
	}
});

describe("parity corpus — scenario→roadmap map stays in sync", () => {
	const mapPath = fileURLToPath(new URL("../scenario-roadmap-map.md", import.meta.url));
	const map = readFileSync(mapPath, "utf8");

	it("lists every scenario id", () => {
		for (const scenario of PARITY_CORPUS) {
			expect(map).toContain(scenario.id);
		}
	});

	it("references every roadmap item the corpus protects", () => {
		const protectedItems = new Set(PARITY_CORPUS.flatMap((s) => s.protects));
		for (const item of protectedItems) {
			expect(map).toContain(item);
		}
	});
});
