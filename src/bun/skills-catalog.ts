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

/**
 * Scan the global agent skill directories (`~/.agents/skills`,
 * `~/.claude/skills`, `~/.codex/skills`) for `<skill>/SKILL.md` entries.
 * Skills with the same name are deduplicated; the first source in the
 * priority order above wins. Result is sorted by name.
 */
export function listAgentSkills(home: string = homedir()): AgentSkillInfo[] {
	const byName = new Map<string, AgentSkillInfo>();

	for (const { dir, source } of SOURCE_DIRS) {
		const root = join(home, dir);
		if (!existsSync(root)) continue;
		let entries: string[];
		try {
			entries = readdirSync(root);
		} catch {
			continue;
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

	return [...byName.values()].sort((a, b) =>
		a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
	);
}
