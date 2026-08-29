import { describe, expect, it } from "vitest";
import {
	assertCompleteSource,
	generateLowBatteryModule,
	LowBatterySourceError,
	type LowBatterySource,
} from "../../../scripts/low-battery-generator";

/** A tree that satisfies the floors, so each test can break exactly one thing. */
function completeSource(overrides: Partial<LowBatterySource> = {}): LowBatterySource {
	const skillFiles: Record<string, string> = {
		"SKILL.md": "# low-battery",
		"agents/openai.yaml": "name: low-battery",
	};
	for (let i = 1; i <= 6; i++) skillFiles[`templates/T${i}.md`] = `## T${i}`;
	for (const name of ["certainty", "numbers", "proportions", "page-builder"]) {
		skillFiles[`reference/${name}.md`] = `# ${name}`;
	}
	return {
		revision: "a".repeat(40),
		outputStyle: "---\nname: Low Battery\n---\n# Low Battery",
		skillFiles,
		...overrides,
	};
}

describe("generateLowBatteryModule", () => {
	it("survives the markdown the rules are actually made of", () => {
		// Backticks, `${...}`, quotes, backslashes and newlines all in one file:
		// this is the escaping the generator exists to take off a human's hands.
		const nasty = 'A `code` span, ${notATemplate}, "quotes", back\\slash,\nand a newline.';
		const module = generateLowBatteryModule(
			completeSource({ outputStyle: nasty, revision: "b".repeat(40) }),
		);

		// Evaluate the emitted literal the way the bundler will read it.
		const literal = /LOW_BATTERY_OUTPUT_STYLE = (".*");/.exec(module)?.[1];
		expect(literal).toBeDefined();
		expect(JSON.parse(literal as string)).toBe(nasty);
		expect(module).toContain(`LOW_BATTERY_REVISION = "${"b".repeat(40)}"`);
	});

	it("carries every skill file through, sorted for a stable diff", () => {
		const src = completeSource();
		const module = generateLowBatteryModule(src);

		for (const path of Object.keys(src.skillFiles)) {
			expect(module).toContain(`\t${JSON.stringify(path)}:`);
		}
		const order = [...module.matchAll(/^\t"([^"]+)":/gm)].map((m) => m[1]);
		expect(order).toEqual([...order].sort());
	});

	it("round-trips a fenced code block and a template-literal lookalike in a skill file", () => {
		const nasty = "```ts\nconst x = `${a}` // and a \" quote\n```";
		const src = completeSource();
		src.skillFiles["templates/T1.md"] = nasty;
		const module = generateLowBatteryModule(src);

		const literal = /^\t"templates\/T1\.md": (".*"),$/m.exec(module)?.[1];
		expect(literal).toBeDefined();
		expect(JSON.parse(literal as string)).toBe(nasty);
	});
});

describe("assertCompleteSource", () => {
	it("accepts a complete tree", () => {
		expect(() => assertCompleteSource(completeSource())).not.toThrow();
	});

	it.each([
		["an empty tree", { skillFiles: {} }],
		["a missing SKILL.md", { skillFiles: { "agents/openai.yaml": "x" } }],
		["an empty output style", { outputStyle: "   " }],
		["no revision", { revision: "" }],
	])("rejects %s", (_label, overrides) => {
		expect(() => assertCompleteSource(completeSource(overrides as Partial<LowBatterySource>))).toThrow(
			LowBatterySourceError,
		);
	});

	it("rejects a truncated clone that kept SKILL.md but lost the templates", () => {
		const src = completeSource();
		for (const path of Object.keys(src.skillFiles)) {
			if (path.startsWith("templates/")) delete src.skillFiles[path];
		}
		expect(() => assertCompleteSource(src)).toThrow(/templates/);
	});

	it("rejects a clone whose files exist but are empty", () => {
		const src = completeSource();
		for (const path of Object.keys(src.skillFiles)) {
			if (path.startsWith("reference/")) src.skillFiles[path] = "\n  \n";
		}
		expect(() => assertCompleteSource(src)).toThrow(/reference/);
	});
});
