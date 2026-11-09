import { describe, it, expect } from "vitest";
import {
	CONFIG_FIELDS,
	CONFIG_KEYS,
	CONFIG_SCHEMA_VERSION,
	COMMAND_BEARING_CONFIG_KEYS,
	configDefaults,
	configJsonSchema,
	fieldUi,
	getFieldSpec,
	migrateConfig,
	parseCliValue,
	renderConfigFieldTable,
	resolveConfigPath,
	suggestConfigKey,
	validateConfigFile,
	validateValue,
} from "../../shared/config-schema";
import { DEV3_REPO_CONFIG_KEYS } from "../../shared/types";

describe("config schema registry", () => {
	it("is the source of DEV3_REPO_CONFIG_KEYS", () => {
		expect([...DEV3_REPO_CONFIG_KEYS]).toEqual(CONFIG_KEYS);
	});

	it("covers every field the cascade knew before the schema existed", () => {
		expect(CONFIG_KEYS).toEqual(expect.arrayContaining([
			"setupScript", "setupScriptLaunchMode", "devScript", "devServers", "cleanupScript", "clonePaths",
			"defaultBaseBranch", "defaultCompareRef", "defaultCompareRefMode", "autoReviewEnabled", "peerReviewEnabled",
			"sparseCheckoutEnabled", "sparseCheckoutPaths", "builtinColumnAgents", "portCount", "env",
		]));
	});

	// Additive defaults: a project that sets nothing must behave exactly as before.
	it("keeps the cascade defaults identical to the pre-schema DEFAULTS", () => {
		expect(configDefaults()).toEqual({
			setupScript: "",
			setupScriptLaunchMode: "parallel",
			devScript: "",
			cleanupScript: "",
			clonePaths: [],
			defaultBaseBranch: "main",
			autoReviewEnabled: false,
			peerReviewEnabled: true,
			sparseCheckoutEnabled: false,
			sparseCheckoutPaths: [],
		});
	});

	it("keeps the command-bearing set of the security boundary", () => {
		expect([...COMMAND_BEARING_CONFIG_KEYS].sort()).toEqual(
			["builtinColumnAgents", "cleanupScript", "devScript", "devServers", "env", "setupScript", "setupScriptLaunchMode"].sort(),
		);
	});

	it.each(CONFIG_KEYS)("%s documents itself with a valid example and default", (key) => {
		const spec = getFieldSpec(key);
		expect(spec.description.length).toBeGreaterThan(10);
		expect(validateValue(spec.type, spec.example, key)).toEqual([]);
		if (spec.default !== undefined) expect(validateValue(spec.type, spec.default, key)).toEqual([]);
		else expect(spec.defaultNote).toBeTruthy();
		if (fieldUi(key) === "none") expect(spec.uiNote).toBeTruthy();
	});
});

describe("validateConfigFile", () => {
	it("accepts a typical config", () => {
		expect(validateConfigFile({
			schemaVersion: 1,
			setupScript: "npm install",
			clonePaths: ["node_modules"],
			portCount: 2,
			env: { NODE_ENV: "development" },
			devServers: { api: { script: "npm run api", ports: ["api"] } },
		})).toEqual({ errors: [], warnings: [] });
	});

	it("reports wrong types with the path", () => {
		const { errors } = validateConfigFile({ portCount: "2", clonePaths: ["a", 3], setupScriptLaunchMode: "later" });
		expect(errors.map((e) => e.path)).toEqual(["portCount", "clonePaths[1]", "setupScriptLaunchMode"]);
	});

	it("enforces integer range and nested required props", () => {
		const { errors } = validateConfigFile({ portCount: 99, devServers: { api: { ports: [] } } });
		expect(errors).toEqual([
			{ path: "portCount", message: "must be at most 20, got 99" },
			{ path: "devServers.api.script", message: "is required" },
		]);
	});

	it("rejects devServers.dev while devScript is set", () => {
		const { errors } = validateConfigFile({ devScript: "npm run dev", devServers: { dev: { script: "x" } } });
		expect(errors.map((e) => e.path)).toContain("devServers.dev");
	});

	it("warns, never errors, on unknown keys and suggests the closest one", () => {
		const result = validateConfigFile({ setupScritp: "npm i", somethingNew: true });
		expect(result.errors).toEqual([]);
		expect(result.warnings[0].message).toContain('did you mean "setupScript"');
		expect(result.warnings[1].path).toBe("somethingNew");
	});

	it("warns on a file from a newer schema", () => {
		const { errors, warnings } = validateConfigFile({ schemaVersion: CONFIG_SCHEMA_VERSION + 1 });
		expect(errors).toEqual([]);
		expect(warnings[0].path).toBe("schemaVersion");
	});

	it("errors when the file is not an object", () => {
		expect(validateConfigFile([1]).errors[0].message).toContain("JSON object");
	});

	it("treats null as not set", () => {
		expect(validateConfigFile({ portCount: null }).errors).toEqual([]);
	});
});

describe("migrateConfig", () => {
	it("is a no-op for a current or unversioned file", () => {
		const raw = { setupScript: "x" };
		expect(migrateConfig(raw)).toEqual({ config: raw, fromVersion: 1, migrated: false });
	});

	it("runs each step in order and stamps the new version", () => {
		const migrations = {
			1: (c: Record<string, unknown>) => ({ ...c, renamed: c.old, old: undefined }),
			2: (c: Record<string, unknown>) => ({ ...c, step2: true }),
		};
		const result = migrateConfig({ old: "v" }, migrations, 3);
		expect(result.migrated).toBe(true);
		expect(result.config).toMatchObject({ renamed: "v", step2: true, schemaVersion: 3 });
	});

	it("leaves a newer file as is", () => {
		expect(migrateConfig({ schemaVersion: 9, x: 1 }).migrated).toBe(false);
	});

	it("fails loudly on a missing step", () => {
		expect(() => migrateConfig({}, {}, 2)).toThrow("No config migration from schema 1 to 2");
	});
});

describe("CLI value parsing", () => {
	it("parses by type", () => {
		expect(parseCliValue(getFieldSpec("setupScript").type, "npm i && echo ok")).toBe("npm i && echo ok");
		expect(parseCliValue(getFieldSpec("peerReviewEnabled").type, "off")).toBe(false);
		expect(parseCliValue(getFieldSpec("portCount").type, "3")).toBe(3);
		expect(parseCliValue(getFieldSpec("clonePaths").type, "node_modules, .env")).toEqual(["node_modules", ".env"]);
		expect(parseCliValue(getFieldSpec("clonePaths").type, "[]")).toEqual([]);
		expect(parseCliValue(getFieldSpec("env").type, '{"A":"1"}')).toEqual({ A: "1" });
	});

	it("explains a bad value", () => {
		expect(() => parseCliValue(getFieldSpec("portCount").type, "two")).toThrow("expected an integer");
		expect(() => parseCliValue(getFieldSpec("env").type, "{bad")).toThrow("invalid JSON");
	});

	it("resolves dotted record paths and rejects the rest", () => {
		expect(resolveConfigPath("env.NODE_ENV")).toMatchObject({ key: "env", sub: "NODE_ENV", spec: { kind: "string" } });
		expect(() => resolveConfigPath("portCount.x")).toThrow("only record fields");
		expect(() => resolveConfigPath("setupScritp")).toThrow('Did you mean "setupScript"');
	});

	it("does not suggest a key for unrelated words", () => {
		expect(suggestConfigKey("zzzzzzzz")).toBeUndefined();
	});
});

describe("generated docs", () => {
	// Acceptance: a field added to CONFIG_FIELDS is documented with no other edit.
	it("lists every field in the JSON Schema and the skill table", () => {
		const schema = configJsonSchema() as { properties: Record<string, unknown> };
		const table = renderConfigFieldTable();
		for (const key of Object.keys(CONFIG_FIELDS)) {
			expect(schema.properties[key]).toBeDefined();
			expect(table).toContain(`| \`${key}\` |`);
		}
		expect(schema.properties.schemaVersion).toBeDefined();
	});
});
