import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliCommandSpecs } from "../../cli/help";
import { DEV3_AUTO_APPROVED_SUBCOMMANDS } from "../../shared/agent-hooks";
import { buildCodexDev3Rules, CODEX_DEV3_RULES_HEADER, dev3PromptPrefixes } from "../../shared/codex-exec-policy";
import { codexDev3RulesContent, ensureCodexDev3Rules } from "../codex-rules";

const srcRoot = join(__dirname, "..", "..");

/** Codex's prefix_rule semantics: a rule matches when its tokens open argv. */
function prompts(argv: string[]): boolean {
	const [program, ...rest] = argv;
	if (program !== "dev3") return false;
	return dev3PromptPrefixes(cliCommandSpecs()).some((prefix) => prefix.every((token, i) => rest[i] === token));
}

function words(command: string): string[] {
	return command.split(" ");
}

describe("Codex dev3 execpolicy rules (#2043)", () => {
	it.each([
		"dev3 pane run touch-probe",
		"dev3 dev-server start",
		"dev3 dev-server restart",
		"dev3 agent spawn --task seq:1",
		"dev3 automations run x",
		"dev3 automations create x",
		"dev3 secret run --env A -- ls",
		"dev3 __pane-run x",
		"dev3 remote",
		"dev3 update",
		"dev3 --instance primary pane run ls",
		"dev3 pane --instance primary run ls",
		"dev3 local pane run ls",
	])("asks the user before %s", (command) => {
		expect(prompts(words(command))).toBe(true);
	});

	it("never prompts on an allowlisted metadata subcommand", () => {
		for (const entry of DEV3_AUTO_APPROVED_SUBCOMMANDS) {
			expect(prompts(["dev3", ...words(entry), "--json"]), entry).toBe(false);
		}
	});

	it("covers every top-level command main.ts dispatches", () => {
		const main = readFileSync(join(srcRoot, "cli", "main.ts"), "utf-8");
		const dispatched = new Set([
			...[...main.matchAll(/\bcase "([a-z][a-z-]*)":/g)].map((m) => m[1]),
			...[...main.matchAll(/[^b]command === "([a-z][a-z-]*)"/g)].map((m) => m[1]),
		]);
		const known = new Set(cliCommandSpecs().map((spec) => spec.name));
		const missing = [...dispatched].filter((name) => !known.has(name));
		expect(missing).toEqual([]);
	});

	it.each([
		["pane", "pane.ts"],
		["dev-server", "dev-server.ts"],
		["automations", "automations.ts"],
		["projects", "projects.ts"],
	])("knows every %s subcommand its handler accepts", (command, file) => {
		const source = readFileSync(join(srcRoot, "cli", "commands", file), "utf-8");
		const handled = [...source.matchAll(/\bcase "([a-z][a-z-]*)":/g)].map((m) => m[1]);
		const spec = cliCommandSpecs().find((s) => s.name === command);
		expect(handled.filter((sub) => !spec?.subcommands.includes(sub))).toEqual([]);
	});

	it("writes one prompt rule per prefix, for every CLI spelling", () => {
		const text = buildCodexDev3Rules([{ name: "pane", subcommands: ["run", "list"] }], ["dev3", "~/.dev3.0/bin/dev3"]);
		expect(text.startsWith(CODEX_DEV3_RULES_HEADER)).toBe(true);
		expect(text).toContain('prefix_rule(pattern=[["dev3", "~/.dev3.0/bin/dev3"], "pane", "run"], decision="prompt"');
		expect(text).not.toContain('"pane", "list"]');
		expect(text).not.toContain('decision="allow"');
	});
});

describe("ensureCodexDev3Rules", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("writes dev3.rules beside the user's own rules and leaves those alone", () => {
		dir = mkdtempSync(join(tmpdir(), "codex-rules-"));
		mkdirSync(join(dir, "rules"));
		writeFileSync(join(dir, "rules", "default.rules"), "user's own\n");
		writeFileSync(join(dir, "rules", "dev3.rules"), "stale\n");

		ensureCodexDev3Rules(dir, "/Users/x");

		const written = readFileSync(join(dir, "rules", "dev3.rules"), "utf-8");
		expect(written).toBe(codexDev3RulesContent("/Users/x"));
		expect(written).toContain('"pane", "run"]');
		expect(readFileSync(join(dir, "rules", "default.rules"), "utf-8")).toBe("user's own\n");
	});
});
