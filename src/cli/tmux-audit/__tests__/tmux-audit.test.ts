/**
 * Deterministic unit tests for the tmux audit's pure logic: fingerprints, the
 * scan boundary, classification resolution, and the advisory verification rules.
 *
 * Deliberately NO live repository assertions — inventory drift (a new tmux
 * token, a stale snapshot, a stale override) is checked by the manual audit
 * command, not by `bun run test` / required CI. See
 * `decisions/2026/07/25/tmux-inventory-advisory-not-gating.md`.
 */

import { describe, it, expect } from "vitest";
import { loadConfig, resolveClassification, resolveRepoRoot, type Inventory, type InventoryEntry } from "../inventory";
import { computeFingerprint, extractSignals, classifyBoundary } from "../scanner";
import { collectManifestProblems, collectSnapshotDrift, entryIdentities, formatProblems } from "../verify";

const config = loadConfig(resolveRepoRoot());

function entry(overrides: Partial<InventoryEntry> = {}): InventoryEntry {
	return {
		path: "src/bun/pty-server.ts",
		occurrences: 3,
		fingerprint: "abc",
		via: "override",
		category: "terminal-runtime",
		roadmapItem: "CUT-005",
		depth: "caller",
		dependencyKind: "active",
		consumer: "pty server",
		deletionPrerequisite: "native terminal default",
		...overrides,
	};
}

function inventoryOf(entries: readonly InventoryEntry[], extra: Partial<Inventory> = {}): Inventory {
	return {
		entries,
		unclassified: [],
		hiddenGrammarFiles: [],
		historical: { fileCount: 0, occurrences: 0 },
		totals: { trackedFiles: 1, inBoundaryClean: 0, inventoried: entries.length, occurrences: 0 },
		byCategory: {},
		byDepth: {},
		byDependencyKind: {},
		byRoadmapItem: {},
		...extra,
	} as Inventory;
}

const taxonomy = {
	categories: { "terminal-runtime": "" },
	roadmap: { "CUT-005": "" },
	depths: { caller: "", "deep-internal": "" },
	dependencyKinds: { active: "" },
	overrides: {},
	rules: [],
} as unknown as typeof config;

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
		expect(classifyBoundary("decisions/2026/07/19/deep-tmux-client.md", boundary)).toBe("historical");
	});

	it("scans real production paths", () => {
		expect(classifyBoundary("src/bun/tmux/client.ts", boundary)).toBe("scan");
		expect(classifyBoundary("src/bun/pty-server.ts", boundary)).toBe("scan");
	});

	it("resolves classification via override before rule", () => {
		const withBoth = {
			...taxonomy,
			overrides: { "src/bun/tmux/client.ts": { ...entry(), depth: "deep-internal" } },
			rules: [{ ...entry(), match: "^src/bun/" }],
		} as unknown as typeof config;
		const resolved = resolveClassification("src/bun/tmux/client.ts", withBoth);
		expect(resolved?.via).toBe("override");
		expect(resolved?.classification.depth).toBe("deep-internal");
	});

	it("falls back to the first matching rule when no override exists", () => {
		const rulesOnly = { ...taxonomy, rules: [{ ...entry(), match: "^src/bun/" }] } as unknown as typeof config;
		expect(resolveClassification("src/bun/other.ts", rulesOnly)?.via).toBe("^src/bun/");
		expect(resolveClassification("docs/x.md", rulesOnly)).toBeNull();
	});
});

describe("tmux audit — advisory verification rules", () => {
	it("accepts a fully classified inventory", () => {
		expect(collectManifestProblems(inventoryOf([entry()]), taxonomy)).toEqual([]);
	});

	it("reports an unclassified dependency", () => {
		const inv = inventoryOf([], {
			unclassified: [{ path: "src/bun/new.ts", occurrences: 2, tokens: { tmux: 2 }, fingerprint: "f" }],
		});
		expect(collectManifestProblems(inv, taxonomy).map((p) => p.kind)).toEqual(["unclassified"]);
	});

	it("reports tmux grammar hiding in an unclassified file", () => {
		const inv = inventoryOf([entry()], { hiddenGrammarFiles: ["src/bun/sneaky.ts"] });
		expect(collectManifestProblems(inv, taxonomy).map((p) => p.kind)).toEqual(["hidden-grammar"]);
	});

	it("reports an unknown taxonomy value", () => {
		const problems = collectManifestProblems(inventoryOf([entry({ depth: "bogus" })]), taxonomy);
		expect(problems.map((p) => p.kind)).toEqual(["unknown-taxonomy"]);
	});

	it("reports a stale override", () => {
		const stale = { ...taxonomy, overrides: { "src/bun/gone.ts": {} } } as unknown as typeof config;
		expect(collectManifestProblems(inventoryOf([entry()]), stale).map((p) => p.kind)).toEqual(["stale-override"]);
	});

	it("ignores line moves but reports added, removed, and reclassified files", () => {
		const committed = [entry(), entry({ path: "src/bun/old.ts" }), entry({ path: "src/bun/kept.ts" })];
		const live = inventoryOf([
			entry({ fingerprint: "changed" }),
			entry({ path: "src/bun/kept.ts" }),
			entry({ path: "src/bun/fresh.ts" }),
		]);
		expect(collectSnapshotDrift(committed, live).map((p) => p.detail)).toEqual([
			"added: src/bun/fresh.ts",
			"changed: src/bun/pty-server.ts",
			"removed: src/bun/old.ts",
		]);
	});

	it("finds no drift when the snapshot matches the scan", () => {
		expect(collectSnapshotDrift([entry()], inventoryOf([entry()]))).toEqual([]);
	});

	it("keys identities on fingerprint plus classification only", () => {
		const a = entryIdentities([entry({ occurrences: 1 })]);
		const b = entryIdentities([entry({ occurrences: 99 })]);
		expect(a).toEqual(b);
	});

	it("formats nothing when there are no problems", () => {
		expect(formatProblems([])).toBe("");
	});

	it("groups formatted problems by kind", () => {
		const report = formatProblems([
			{ kind: "unclassified", detail: "a.ts" },
			{ kind: "unclassified", detail: "b.ts" },
			{ kind: "stale-override", detail: "c.ts" },
		]);
		expect(report).toBe("unclassified (2):\n  a.ts\n  b.ts\n\nstale-override (1):\n  c.ts");
	});
});
