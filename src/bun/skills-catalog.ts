import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSkillInfo } from "../shared/types";

const SOURCE_DIRS: Array<{ dir: string; source: AgentSkillInfo["source"] }> = [
	{ dir: ".agents/skills", source: "agents" },
	{ dir: ".claude/skills", source: "claude" },
	{ dir: ".codex/skills", source: "codex" },
];

/**
 * Extract `name` and `description` from a SKILL.md YAML frontmatter block.
 * Deliberately not a full YAML parser — handles plain scalars, quoted
 * scalars, and block scalars (`|`, `>`, with optional chomping) which cover
 * every SKILL.md in the wild. Returns nulls for absent fields.
 */
export function parseSkillFrontmatter(content: string): { name: string | null; description: string | null } {
	const result: { name: string | null; description: string | null } = { name: null, description: null };
	if (!content.startsWith("---")) return result;
	const end = content.indexOf("\n---", 3);
	if (end === -1) return result;
	const lines = content.slice(content.indexOf("\n") + 1, end).split("\n");

	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(/^(name|description):\s*(.*)$/);
		if (!match) continue;
		const key = match[1] as "name" | "description";
		let value = match[2].trim();
		if (/^[|>][+-]?$/.test(value)) {
			// Block scalar: collect the following more-indented lines.
			const block: string[] = [];
			for (let j = i + 1; j < lines.length; j++) {
				if (lines[j].trim() === "") continue;
				if (!/^\s/.test(lines[j])) break;
				block.push(lines[j].trim());
			}
			value = block.join(" ");
		} else if (
			(value.startsWith('"') && value.endsWith('"') && value.length >= 2)
			|| (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
		) {
			value = value.slice(1, -1);
		}
		result[key] = value || null;
	}
	return result;
}

/** Scan one `<root>/<skill>/SKILL.md` tree into `byName` (first name wins). */
function scanSkillRoot(root: string, source: AgentSkillInfo["source"], byName: Map<string, AgentSkillInfo>): void {
	if (!existsSync(root)) return;
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.startsWith(".")) continue;
		const skillFile = join(root, entry, "SKILL.md");
		try {
			if (!statSync(join(root, entry)).isDirectory()) continue;
			if (!existsSync(skillFile)) continue;
			const parsed = parseSkillFrontmatter(readFileSync(skillFile, "utf8"));
			const name = parsed.name ?? entry;
			if (byName.has(name)) continue;
			byName.set(name, { name, description: parsed.description ?? "", source });
		} catch {
			// Unreadable skill dir/file (permissions, broken symlink) — skip it.
			continue;
		}
	}
}

/**
 * Scan agent skill directories for `<skill>/SKILL.md` entries.
 *
 * When `projectPath` is given, its project-local `.agents/skills`,
 * `.claude/skills`, `.codex/skills` are scanned **first** so a project-local
 * skill wins over a same-named global one. Then the global directories under
 * `home` (`~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`) are added.
 * Skills with the same name are deduplicated (first seen wins). Result is
 * sorted by name.
 */
export function listAgentSkills(home: string = homedir(), projectPath?: string | null): AgentSkillInfo[] {
	const byName = new Map<string, AgentSkillInfo>();

	// Project-local skills first — they win dedup over global ones.
	if (projectPath) {
		for (const { dir, source } of SOURCE_DIRS) {
			scanSkillRoot(join(projectPath, dir), source, byName);
		}
	}

	for (const { dir, source } of SOURCE_DIRS) {
		scanSkillRoot(join(home, dir), source, byName);
	}

	return [...byName.values()].sort((a, b) =>
		a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
	);
}
