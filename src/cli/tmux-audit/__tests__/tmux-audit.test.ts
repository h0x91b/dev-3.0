import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
	buildInventory,
	loadConfig,
	resolveClassification,
	resolveRepoRoot,
	type Inventory,
} from "../inventory";
import { computeFingerprint, extractSignals, classifyBoundary } from "../scanner";

const repoRoot = resolveRepoRoot();
const config = loadConfig(repoRoot);
const inventory: Inventory = buildInventory(repoRoot, config);

/** Stable per-file identity: content fingerprint + classification, no line numbers. */
function identity(inv: Inventory): Record<string, string> {
	const map: Record<string, string> = {};
	for (const e of inv.entries) {
		map[e.path] = [e.fingerprint, e.category, e.roadmapItem, e.depth, e.dependencyKind].join("|");
	}
	return map;
}

describe("tmux audit — deterministic no-unclassified check", () => {
	it("classifies every scanned production tmux dependency", () => {
		const missing = inventory.unclassified.map((f) => f.path);
		// A new production tmux dependency that no override/rule covers fails here.
		expect(missing, `unclassified tmux dependencies (add an override or rule):\n${missing.join("\n")}`).toEqual([]);
	});

	it("keeps the committed inventory.json in sync (stable identities)", () => {
		const committedRaw = readFileSync(path.join(repoRoot, "src/cli/tmux-audit/inventory.json"), "utf8");
		const committed = JSON.parse(committedRaw) as { entries: Inventory["entries"] };
		const committedInventory = { entries: committed.entries } as Inventory;

		// Compare the churn-stable projection: moving lines does not change the
		// fingerprint, so pure reordering never trips this; a new/removed tmux
		// token or a reclassification does — forcing `bun generate` + review.
		expect(identity(committedInventory)).toEqual(identity(inventory));
	});

	it("has no stale overrides (every override still carries tmux signals)", () => {
		const scannedPaths = new Set(inventory.entries.map((e) => e.path));
		const stale = Object.keys(config.overrides).filter((p) => !scannedPaths.has(p));
		expect(stale, `stale overrides — remove them from audit.config.json:\n${stale.join("\n")}`).toEqual([]);
	});

	it("classifies every file that hides tmux grammar without the literal token", () => {
		const entryPaths = new Set(inventory.entries.map((e) => e.path));
		const unclassifiedHidden = inventory.hiddenGrammarFiles.filter((p) => !entryPaths.has(p));
		expect(unclassifiedHidden).toEqual([]);
	});

	it("uses only known categories, depths, kinds, and roadmap items", () => {
		for (const e of inventory.entries) {
			expect(config.categories, e.path).toHaveProperty(e.category);
			expect(config.depths, e.path).toHaveProperty(e.depth);
			expect(config.dependencyKinds, e.path).toHaveProperty(e.dependencyKind);
			expect(config.roadmap, e.path).toHaveProperty(e.roadmapItem);
		}
	});

	it("reports the deep-internal vs caller split distinctly", () => {
		expect(inventory.byDepth["deep-internal"]).toBeGreaterThan(0);
		expect(inventory.byDepth["caller"]).toBeGreaterThan(0);
		// The adapter must stay strictly smaller than its caller surface.
		expect(inventory.byDepth["deep-internal"]).toBeLessThan(inventory.byDepth["caller"] ?? 0);
	});
});

describe("tmux audit — fingerprint stability (line moves must not churn)", () => {
	const original = [
		"import { tmux } from './tmux';",
		"await tmux.newSession(name);",
		"await tmux.capturePane(paneId);",
	].join("\n");

	it("is unchanged when lines are merely reordered", () => {
		const reordered = [
			"await tmux.capturePane(paneId);",
			"import { tmux } from './tmux';",
			"await tmux.newSession(name);",
		].join("\n");
		const a = computeFingerprint(extractSignals(original).tokens);
		const b = computeFingerprint(extractSignals(reordered).tokens);
		expect(b).toBe(a);
	});

	it("changes when a new tmux signal is introduced", () => {
		const withNew = original + "\nawait tmux.killSession(name);";
		const a = computeFingerprint(extractSignals(original).tokens);
		const b = computeFingerprint(extractSignals(withNew).tokens);
		expect(b).not.toBe(a);
	});

	it("detects a new tmux grammar token even without the literal word", () => {
		const base = "// tmux socket helper\nconst x = 1;";
		const withGrammar = base + "\nrun('send-keys', '-t', pane);";
		expect(computeFingerprint(extractSignals(withGrammar).tokens)).not.toBe(
			computeFingerprint(extractSignals(base).tokens),
		);
	});
});

describe("tmux audit — boundary is cross-platform and self-excluding", () => {
	const boundary = {
		excludeDirs: config.boundary.excludeDirs,
		historicalDirs: config.boundary.historicalDirs,
		excludeExtensions: config.boundary.excludeExtensions,
		excludePaths: config.boundary.excludePaths,
	};

	it("excludes the audit tool's own directory (no self-reference)", () => {
		expect(classifyBoundary("src/cli/tmux-audit/audit.config.json", boundary)).toBe("excluded");
		expect(classifyBoundary("src/cli/tmux-audit/scanner.ts", boundary)).toBe("excluded");
	});

	it("treats changelogs and ADRs as historical, not inventoried", () => {
		expect(classifyBoundary("change-logs/2026/07/23/fix-x.md", boundary)).toBe("historical");
		expect(classifyBoundary("decisions/138-deep-tmux-client.md", boundary)).toBe("historical");
	});

	it("scans real production paths", () => {
		expect(classifyBoundary("src/bun/tmux/client.ts", boundary)).toBe("scan");
		expect(classifyBoundary("src/bun/pty-server.ts", boundary)).toBe("scan");
	});

	it("resolves classification via override before rule", () => {
		const resolved = resolveClassification("src/bun/tmux/client.ts", config);
		expect(resolved?.via).toBe("override");
		expect(resolved?.classification.depth).toBe("deep-internal");
	});
});
