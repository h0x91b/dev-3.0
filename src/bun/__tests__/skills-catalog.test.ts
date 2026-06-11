import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAgentSkills, parseSkillFrontmatter } from "../skills-catalog";

describe("parseSkillFrontmatter", () => {
	it("parses plain name and description", () => {
		const md = "---\nname: dev3\ndescription: Manage dev3 tasks\n---\n\n# Body";
		expect(parseSkillFrontmatter(md)).toEqual({ name: "dev3", description: "Manage dev3 tasks" });
	});

	it("strips surrounding quotes", () => {
		const md = '---\nname: "dev3"\ndescription: \'Quoted desc\'\n---\n';
		expect(parseSkillFrontmatter(md)).toEqual({ name: "dev3", description: "Quoted desc" });
	});

	it("joins block-scalar descriptions", () => {
		const md = "---\nname: foo\ndescription: >-\n  Line one\n  line two\nallowed-tools: Bash\n---\n";
		expect(parseSkillFrontmatter(md)).toEqual({ name: "foo", description: "Line one line two" });
	});

	it("returns nulls without frontmatter", () => {
		expect(parseSkillFrontmatter("# Just markdown")).toEqual({ name: null, description: null });
	});

	it("returns nulls for unterminated frontmatter", () => {
		expect(parseSkillFrontmatter("---\nname: x\n")).toEqual({ name: null, description: null });
	});
});

describe("listAgentSkills", () => {
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "dev3-skills-test-"));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	function addSkill(dir: string, slug: string, frontmatter: string | null) {
		const skillDir = join(home, dir, slug);
		mkdirSync(skillDir, { recursive: true });
		if (frontmatter !== null) {
			writeFileSync(join(skillDir, "SKILL.md"), frontmatter);
		}
	}

	it("returns empty when no skill directories exist", () => {
		expect(listAgentSkills(home)).toEqual([]);
	});

	it("collects skills from all three sources, sorted by name", () => {
		addSkill(".agents/skills", "zeta", "---\nname: zeta\ndescription: Z\n---\n");
		addSkill(".claude/skills", "alpha", "---\nname: alpha\ndescription: A\n---\n");
		addSkill(".codex/skills", "mid", "---\nname: mid\ndescription: M\n---\n");
		expect(listAgentSkills(home)).toEqual([
			{ name: "alpha", description: "A", source: "claude" },
			{ name: "mid", description: "M", source: "codex" },
			{ name: "zeta", description: "Z", source: "agents" },
		]);
	});

	it("dedupes by name with agents dir taking priority", () => {
		addSkill(".agents/skills", "dev3", "---\nname: dev3\ndescription: from agents\n---\n");
		addSkill(".claude/skills", "dev3", "---\nname: dev3\ndescription: from claude\n---\n");
		const result = listAgentSkills(home);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ name: "dev3", description: "from agents", source: "agents" });
	});

	it("falls back to the directory name when frontmatter has no name", () => {
		addSkill(".claude/skills", "my-skill", "# No frontmatter here");
		expect(listAgentSkills(home)).toEqual([{ name: "my-skill", description: "", source: "claude" }]);
	});

	it("skips directories without SKILL.md and hidden entries", () => {
		addSkill(".claude/skills", "real", "---\nname: real\ndescription: ok\n---\n");
		addSkill(".claude/skills", "empty-dir", null);
		addSkill(".claude/skills", ".hidden", "---\nname: hidden\n---\n");
		const result = listAgentSkills(home);
		expect(result.map((s) => s.name)).toEqual(["real"]);
	});
});
