import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const workflowsDir = resolve(repoRoot, ".github/workflows");

/**
 * Scans EVERY workflow, not just release.yml. It used to name that one file, and the
 * per-platform build extraction moved every `hashFiles('bun.lock')` out of it — so the
 * named version went red for the right reason and would have been "fixed" by pointing it
 * at the new files, rebuilding the same cap one file over. A fixed list of inputs is a
 * silent limit.
 */
function cacheKeyLockfiles(): Array<{ workflow: string; lockfile: string }> {
	const found: Array<{ workflow: string; lockfile: string }> = [];
	for (const entry of readdirSync(workflowsDir, { withFileTypes: true })) {
		if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
		const yaml = readFileSync(join(workflowsDir, entry.name), "utf8");
		for (const match of yaml.matchAll(/hashFiles\('([^']+)'\)/g)) {
			found.push({ workflow: entry.name, lockfile: match[1] });
		}
	}
	return found;
}

describe("workflow cache keys reference lockfiles that exist", () => {
	// Zero matches must FAIL. An empty set makes the assertion below iterate nothing and
	// pass while guarding nothing — the same absence-looks-like-success hole the publisher
	// detectors refuse to fall into.
	it("finds cache keys to check at all", () => {
		expect(
			cacheKeyLockfiles().length,
			"no `hashFiles('...')` cache keys found in any workflow. Either dependency caching was removed everywhere, or this matcher stopped matching — in both cases the check below guards nothing. Fix: teach the matcher the new form; do not delete the assertion.",
		).toBeGreaterThan(0);
	});

	it("hashes only lockfiles that exist in the repository", () => {
		const missing = cacheKeyLockfiles()
			.filter(({ lockfile }) => !existsSync(resolve(repoRoot, lockfile)))
			.map(({ workflow, lockfile }) => `${workflow} hashes ${lockfile}`);

		expect(
			missing,
			`These workflows build a cache key from a lockfile that does not exist, so the key is constant and the cache never invalidates:\n${missing.join("\n")}\nFix: point hashFiles() at a real lockfile path.`,
		).toEqual([]);
	});
});
