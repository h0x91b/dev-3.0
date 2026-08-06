/**
 * Decision records live at `decisions/YYYY/MM/DD/slug.md`. Sequential numbering could not
 * survive parallel worktrees — agents branching off the same `main` all read the same
 * highest number — and the repo accumulated 98 shared numbers before anyone noticed.
 * Prose alone already failed to prevent that, so the rule is asserted here.
 * See decisions/2026/08/06/decision-records-dated-not-numbered.md.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LEGACY_DECISION_RECORDS } from "./fixtures/legacy-decision-records";

const DECISIONS_DIR = fileURLToPath(new URL("../../../decisions", import.meta.url));
/** The slug must start with a letter, so a numbered name cannot hide inside a dated directory. */
const DATED_PATH = /^\d{4}\/\d{2}\/\d{2}\/[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\.md$/;
const MAP = readFileSync(`${DECISIONS_DIR}/README.md`, "utf8");

/** Every `.md` under decisions/, as a path relative to it. README.md is the map, not a record. */
function records(dir = DECISIONS_DIR, prefix = ""): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) return records(`${dir}/${entry.name}`, rel);
		return entry.name.endsWith(".md") && rel !== "README.md" ? [rel] : [];
	});
}

const onDisk = records();

describe("decision record paths", () => {
	it("files every record under `YYYY/MM/DD/slug.md`", () => {
		const offenders = onDisk.filter((path) => !DATED_PATH.test(path));
		expect(
			offenders,
			`Cause: sequential numbering collides — two agents branching off the same main pick the same number, and the ${LEGACY_DECISION_RECORDS.length} records written under the old scheme already shared 98 numbers between them.\n` +
				`Fix: move it to decisions/YYYY/MM/DD/your-slug.md (today's date, lowercase kebab slug).\n` +
				`Offending: ${offenders.join(", ")}`,
		).toEqual([]);
	});

	it("keeps the slug unique — it is the record's identity, the number never was", () => {
		const bySlug = new Map<string, string[]>();
		for (const path of onDisk) {
			const slug = path.split("/").pop()!.replace(/\.md$/, "");
			bySlug.set(slug, [...(bySlug.get(slug) ?? []), path]);
		}
		const collisions = [...bySlug.entries()].filter(([, paths]) => paths.length > 1);
		expect(
			collisions,
			`Cause: two records share a slug, so citing either one by slug is ambiguous.\nFix: give the new record a more specific slug.`,
		).toEqual([]);
	});

	it("keeps decisions/README.md mapping every old numbered name to a record that exists", () => {
		const missing = LEGACY_DECISION_RECORDS.filter((old) => !MAP.includes(`\`${old}\``));
		expect(
			missing,
			`Cause: an old numbered name lost its row in decisions/README.md. Those names are cited from merged PR bodies, issues, git history and agents' memories, which cannot be updated — the map is the only way they still resolve.\n` +
				`Fix: restore the row.\nMissing: ${missing.join(", ")}`,
		).toEqual([]);

		const dangling = [...MAP.matchAll(/\|\s*`\d{3}-[^`]+`\s*\|\s*\[`([^`]+)`\]/g)]
			.map((m) => m[1])
			.filter((target) => !onDisk.includes(target));
		expect(dangling, `Cause: the map points at records that are not on disk.\nFix: correct the target path.`).toEqual([]);
	});

	it("has a frozen legacy list that is numeric-only and duplicate-free", () => {
		expect(LEGACY_DECISION_RECORDS.filter((name) => !/^\d{3}-/.test(name))).toEqual([]);
		expect(new Set(LEGACY_DECISION_RECORDS).size).toBe(LEGACY_DECISION_RECORDS.length);
	});
});
