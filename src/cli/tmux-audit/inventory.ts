/**
 * Builds the classified tmux-dependency inventory from `audit.config.json` and a
 * live repository scan. Pure with respect to the repo — it only reads. Shared by
 * `generate.ts` (writes the artifacts) and the deterministic check test.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	scanRepo,
	findHiddenGrammarFiles,
	type FileSignals,
	type ScanBoundary,
	type RepoScan,
} from "./scanner";

export interface Classification {
	readonly category: string;
	readonly roadmapItem: string;
	readonly depth: string;
	readonly dependencyKind: string;
	readonly consumer: string;
	readonly deletionPrerequisite: string;
}

interface Rule extends Classification {
	readonly match: string;
}

export interface AuditConfig {
	readonly description: string;
	readonly boundary: ScanBoundary & {
		readonly note: string;
		readonly historicalNote: string;
	};
	readonly categories: Readonly<Record<string, string>>;
	readonly roadmap: Readonly<Record<string, string>>;
	readonly depths: Readonly<Record<string, string>>;
	readonly dependencyKinds: Readonly<Record<string, string>>;
	readonly rules: readonly Rule[];
	readonly overrides: Readonly<Record<string, Classification>>;
}

export interface InventoryEntry extends Classification {
	readonly path: string;
	readonly occurrences: number;
	readonly fingerprint: string;
	/** How this path was classified: an exact override or a matched rule. */
	readonly via: "override" | string;
}

export interface Inventory {
	readonly entries: readonly InventoryEntry[];
	/** Scanned files with tmux signals that no rule/override classified. */
	readonly unclassified: readonly FileSignals[];
	/** Files with tmux grammar but no literal token (must all be classified). */
	readonly hiddenGrammarFiles: readonly string[];
	readonly historical: {
		readonly fileCount: number;
		readonly occurrences: number;
	};
	readonly totals: {
		readonly trackedFiles: number;
		readonly inBoundaryClean: number;
		readonly inventoried: number;
		readonly occurrences: number;
	};
	readonly byCategory: Readonly<Record<string, number>>;
	readonly byDepth: Readonly<Record<string, number>>;
	readonly byDependencyKind: Readonly<Record<string, number>>;
	readonly byRoadmapItem: Readonly<Record<string, number>>;
}

const CONFIG_RELATIVE = "src/cli/tmux-audit/audit.config.json";

/** Repo root, resolved from this module's location via git (cross-platform). */
export function resolveRepoRoot(): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const root = execFileSync("git", ["-C", here, "rev-parse", "--show-toplevel"], {
		encoding: "utf8",
	}).trim();
	return root;
}

export function loadConfig(repoRoot: string): AuditConfig {
	const raw = readFileSync(path.join(repoRoot, CONFIG_RELATIVE), "utf8");
	return JSON.parse(raw) as AuditConfig;
}

/** Resolve a scanned path to its classification: exact override first, then rules. */
export function resolveClassification(
	relPath: string,
	config: AuditConfig,
): { classification: Classification; via: "override" | string } | null {
	const override = config.overrides[relPath];
	if (override) return { classification: override, via: "override" };
	for (const rule of config.rules) {
		if (new RegExp(rule.match).test(relPath)) {
			const { match: _match, ...classification } = rule;
			return { classification, via: rule.match };
		}
	}
	return null;
}

function increment(map: Record<string, number>, key: string): void {
	map[key] = (map[key] ?? 0) + 1;
}

export function buildInventory(repoRoot: string, config: AuditConfig, scan?: RepoScan): Inventory {
	const boundary: ScanBoundary = {
		excludeDirs: config.boundary.excludeDirs,
		historicalDirs: config.boundary.historicalDirs,
		excludeExtensions: config.boundary.excludeExtensions,
		excludePaths: config.boundary.excludePaths,
	};
	const repoScan = scan ?? scanRepo(repoRoot, boundary);

	const entries: InventoryEntry[] = [];
	const unclassified: FileSignals[] = [];
	const byCategory: Record<string, number> = {};
	const byDepth: Record<string, number> = {};
	const byDependencyKind: Record<string, number> = {};
	const byRoadmapItem: Record<string, number> = {};
	let occurrences = 0;

	for (const file of repoScan.scanned) {
		const resolved = resolveClassification(file.path, config);
		if (!resolved) {
			unclassified.push(file);
			continue;
		}
		const { classification, via } = resolved;
		entries.push({
			path: file.path,
			occurrences: file.occurrences,
			fingerprint: file.fingerprint,
			via,
			...classification,
		});
		occurrences += file.occurrences;
		increment(byCategory, classification.category);
		increment(byDepth, classification.depth);
		increment(byDependencyKind, classification.dependencyKind);
		increment(byRoadmapItem, classification.roadmapItem);
	}

	const historicalOccurrences = repoScan.historical.reduce((sum, f) => sum + f.occurrences, 0);

	return {
		entries,
		unclassified,
		hiddenGrammarFiles: findHiddenGrammarFiles(repoRoot, boundary),
		historical: {
			fileCount: repoScan.historical.length,
			occurrences: historicalOccurrences,
		},
		totals: {
			trackedFiles: repoScan.trackedFileCount,
			inBoundaryClean: repoScan.cleanFileCount,
			inventoried: entries.length,
			occurrences,
		},
		byCategory: sortRecord(byCategory),
		byDepth: sortRecord(byDepth),
		byDependencyKind: sortRecord(byDependencyKind),
		byRoadmapItem: sortRecord(byRoadmapItem),
	};
}

function sortRecord(record: Record<string, number>): Record<string, number> {
	return Object.fromEntries(Object.entries(record).sort((a, b) => a[0].localeCompare(b[0])));
}
