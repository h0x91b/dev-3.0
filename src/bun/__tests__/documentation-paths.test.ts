/**
 * `AGENTS.md` is the first file every agent in this repo reads. A path in it that no longer
 * resolves does not merely fail to help — it sends the reader to the wrong file and hands them
 * a false negative when they look. That already cost a coordinator a wrong challenge to an agent
 * that had done its job correctly, so the rule is asserted here instead of trusted to prose.
 *
 * Known blind spot: a token written without its directory is resolved by basename, so citing
 * `application-menu.ts` while the file sits in src/shared/ still passes. Write the full path.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DOCS = ["AGENTS.md", ...readdirSync(`${ROOT}/docs/agents`).map((f) => `docs/agents/${f}`)];

/** Only tokens naming a file are checked; a bare directory or a skill name is not a path. */
const FILE_EXTENSION = /\.(ts|tsx|js|jsx|md|json|css|yml|yaml|html)$/;
const PATH_SHAPED = /^[A-Za-z0-9_.@/-]+$/;
const BACKTICKED = /`([^`\n]+)`/g;
const MARKDOWN_LINK = /\]\(([^)]+)\)/g;
/**
 * Fenced blocks must go first: their ``` marks pair with the inline backticks that follow, which
 * silently shifts every pairing in the rest of the file and hides most of the document.
 */
const FENCED_BLOCK = /^```[\s\S]*?^```/gm;

/**
 * Deliberate non-paths. Each is written knowing the file is absent — removing an entry means
 * the doc now claims something that must resolve.
 */
const ALLOWED = new Map([
	["CONTEXT.md", "documented as deliberately absent — AGENTS.md is the single domain doc"],
	["NNN-slug.md", "the retired decision-record naming, cited only to say it is retired"],
	["decisions/2026/08/06/foo.md", "an invented slug illustrating how to cite a record"],
	["projects.json", "runtime state under ~/.dev3.0, not a repo file"],
	["tasks.json", "runtime state under ~/.dev3.0, not a repo file"],
	["settings.local.json", "per-machine agent settings under .claude, not committed"],
]);

/** `decisions/YYYY/MM/DD/slug.md`, `translations/{locale}/`, `src/mainview/**` and friends. */
const isTemplate = (token: string) => /YYYY|MM\/DD|NNN|[{}*]/.test(token);

function references(doc: string): string[] {
	const text = readFileSync(`${ROOT}/${doc}`, "utf8").replace(FENCED_BLOCK, "");
	const tokens = [
		...[...text.matchAll(BACKTICKED)].map((m) => m[1]),
		...[...text.matchAll(MARKDOWN_LINK)].map((m) => m[1].replace(/#.*$/, "")),
	];
	return [
		...new Set(
			tokens.filter(
				(t) => PATH_SHAPED.test(t) && FILE_EXTENSION.test(t) && !isTemplate(t) && !ALLOWED.has(t),
			),
		),
	];
}

/**
 * Not repo content: build output, and gitignored per-machine state that is present on a developer's
 * box but absent on a fresh checkout. Walking them would make the result depend on the machine.
 */
const NOT_REPO_CONTENT = new Set([
	"node_modules",
	"dist",
	".git",
	"settings.local.json",
]);

/** Every file in the repo by basename, so a token written without its directory still resolves. */
function basenames(dir = ROOT, seen = new Set<string>()): Set<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (NOT_REPO_CONTENT.has(entry.name)) continue;
		if (entry.isDirectory()) basenames(`${dir}/${entry.name}`, seen);
		else seen.add(entry.name);
	}
	return seen;
}

const ALL_BASENAMES = basenames();

const resolves = (token: string) =>
	token.includes("/") ? existsSync(`${ROOT}/${token}`) : ALL_BASENAMES.has(token);

describe("documentation paths", () => {
	for (const doc of DOCS) {
		it(`points every file reference in ${doc} at a file that exists`, () => {
			const broken = references(doc).filter((token) => !resolves(token));
			expect(
				broken,
				`Cause: ${doc} names a file that is not in the repo, so a reader following it finds nothing and concludes the thing does not exist.\n` +
					`Fix: point it at the real path, or — if the file is deliberately absent — add it to ALLOWED in this test with the reason.\n` +
					`Offending: ${broken.join(", ")}`,
			).toEqual([]);
		});
	}

	it("keeps every allowlisted non-path genuinely absent", () => {
		const resurrected = [...ALLOWED.keys()].filter(resolves);
		expect(
			resurrected,
			`Cause: these are allowlisted as deliberately absent, but now exist — the allowlist is hiding a reference that could be checked.\n` +
				`Fix: drop them from ALLOWED.\n` +
				`Offending: ${resurrected.join(", ")}`,
		).toEqual([]);
	});
});
