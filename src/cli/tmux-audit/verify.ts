/**
 * Pure consistency checks for the tmux dependency audit (roadmap INT-008).
 *
 * These are **advisory**: they run from `generate.ts` when a human invokes the
 * audit, not from `bun run test` or required CI. Inventory bookkeeping drift is
 * not a runtime safety invariant, and gating every PR on it blocked unrelated
 * work (see `decisions/2026/07/25/tmux-inventory-advisory-not-gating.md`).
 *
 * Every function here is pure — it takes an already-built inventory plus the
 * committed snapshot and returns findings, so it is unit-testable without a
 * live repository scan.
 */

import type { AuditConfig, Inventory, InventoryEntry } from "./inventory";

export type AuditProblemKind =
	| "unclassified"
	| "hidden-grammar"
	| "unknown-taxonomy"
	| "stale-override"
	| "snapshot-drift";

export interface AuditProblem {
	readonly kind: AuditProblemKind;
	readonly detail: string;
}

/** Stable per-file identity: content fingerprint + classification, no line numbers. */
export function entryIdentities(entries: readonly InventoryEntry[]): Record<string, string> {
	const map: Record<string, string> = {};
	for (const e of entries) {
		map[e.path] = [e.fingerprint, e.category, e.roadmapItem, e.depth, e.dependencyKind].join("|");
	}
	return map;
}

/**
 * Findings that mean the manifest itself is incomplete or wrong — a new tmux
 * dependency nobody classified, tmux grammar hiding without the literal token,
 * a taxonomy typo, or an override pointing at a path that no longer has signals.
 * The generator refuses to write artifacts while any of these exist.
 */
export function collectManifestProblems(inventory: Inventory, config: AuditConfig): AuditProblem[] {
	const problems: AuditProblem[] = [];

	for (const file of inventory.unclassified) {
		problems.push({
			kind: "unclassified",
			detail: `${file.path} (occ ${file.occurrences}; tokens: ${Object.keys(file.tokens).sort().join(", ")})`,
		});
	}

	const entryPaths = new Set(inventory.entries.map((e) => e.path));
	for (const hidden of inventory.hiddenGrammarFiles) {
		if (!entryPaths.has(hidden)) {
			problems.push({ kind: "hidden-grammar", detail: `${hidden} has tmux grammar but no literal token` });
		}
	}

	for (const e of inventory.entries) {
		const unknown = [
			["category", e.category, config.categories],
			["roadmapItem", e.roadmapItem, config.roadmap],
			["depth", e.depth, config.depths],
			["dependencyKind", e.dependencyKind, config.dependencyKinds],
		] as const;
		for (const [field, value, taxonomy] of unknown) {
			if (!(value in taxonomy)) {
				problems.push({ kind: "unknown-taxonomy", detail: `${e.path}: unknown ${field} "${value}"` });
			}
		}
	}

	for (const overridePath of Object.keys(config.overrides)) {
		if (!entryPaths.has(overridePath)) {
			problems.push({ kind: "stale-override", detail: `${overridePath} no longer carries tmux signals` });
		}
	}

	return problems;
}

/**
 * Drift between the committed `inventory.json` snapshot and a fresh scan. Only
 * meaningful in `--check` mode; a plain regenerate resolves it by rewriting.
 */
export function collectSnapshotDrift(
	committed: readonly InventoryEntry[],
	inventory: Inventory,
): AuditProblem[] {
	const before = entryIdentities(committed);
	const after = entryIdentities(inventory.entries);
	const problems: AuditProblem[] = [];

	for (const path of Object.keys(after).sort()) {
		if (!(path in before)) problems.push({ kind: "snapshot-drift", detail: `added: ${path}` });
		else if (before[path] !== after[path]) problems.push({ kind: "snapshot-drift", detail: `changed: ${path}` });
	}
	for (const path of Object.keys(before).sort()) {
		if (!(path in after)) problems.push({ kind: "snapshot-drift", detail: `removed: ${path}` });
	}

	return problems;
}

/** Human-readable report, grouped by finding kind. Empty string when clean. */
export function formatProblems(problems: readonly AuditProblem[]): string {
	if (problems.length === 0) return "";
	const groups = new Map<AuditProblemKind, string[]>();
	for (const p of problems) {
		const list = groups.get(p.kind) ?? [];
		list.push(p.detail);
		groups.set(p.kind, list);
	}
	return [...groups.entries()]
		.map(([kind, details]) => `${kind} (${details.length}):\n${details.map((d) => `  ${d}`).join("\n")}`)
		.join("\n\n");
}
