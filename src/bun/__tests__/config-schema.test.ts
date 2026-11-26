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
	it("is the source of DEV3_REPO_CONFIG_KEYS and covers every field the cascade knew before the schema", () => {
		expect([...DEV3_REPO_CONFIG_KEYS]).toEqual(CONFIG_KEYS);
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

	it("every field documents itself with a valid example and default", () => {
		for (const key of CONFIG_KEYS) {
			const spec = getFieldSpec(key);
			expect(spec.description.length, key).toBeGreaterThan(10);
			expect(validateValue(spec.type, spec.example, key), key).toEqual([]);
			if (spec.default !== undefined) expect(validateValue(spec.type, spec.default, key), key).toEqual([]);
			else expect(spec.defaultNote, key).toBeTruthy();
			if (fieldUi(key) === "none") expect(spec.uiNote, key).toBeTruthy();
		}
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

	it("reports wrong types, out-of-range integers and missing nested props with the path", () => {
		const { errors } = validateConfigFile({ portCount: "2", clonePaths: ["a", 3], setupScriptLaunchMode: "later" });
		expect(errors.map((e) => e.path)).toEqual(["portCount", "clonePaths[1]", "setupScriptLaunchMode"]);
		// Integer range and nested required props.
		expect(validateConfigFile({ portCount: 99, devServers: { api: { ports: [] } } }).errors).toEqual([
			{ path: "portCount", message: "must be at most 20, got 99" },
			{ path: "devServers.api.script", message: "is required" },
		]);
	});

	it("rejects devServers.dev while devScript is set", () => {
		const { errors } = validateConfigFile({ devScript: "npm run dev", devServers: { dev: { script: "x" } } });
		expect(errors.map((e) => e.path)).toContain("devServers.dev");
	});

	it("warns, never errors, on unknown keys (suggesting the closest) and on a newer schema", () => {
		const result = validateConfigFile({ setupScritp: "npm i", somethingNew: true });
		expect(result.errors).toEqual([]);
		expect(result.warnings[0].message).toContain('did you mean "setupScript"');
		expect(result.warnings[1].path).toBe("somethingNew");

		const newer = validateConfigFile({ schemaVersion: CONFIG_SCHEMA_VERSION + 1 });
		expect(newer.errors).toEqual([]);
		expect(newer.warnings[0].path).toBe("schemaVersion");
	});

	it("errors when the file is not an object, and treats null as not set", () => {
		expect(validateConfigFile([1]).errors[0].message).toContain("JSON object");
		expect(validateConfigFile({ portCount: null }).errors).toEqual([]);
	});
});

describe("migrateConfig", () => {
	it("is a no-op for a current, unversioned or newer file", () => {
		const raw = { setupScript: "x" };
		expect(migrateConfig(raw)).toEqual({ config: raw, fromVersion: 1, migrated: false });
		// A file from a newer schema is left as is.
		expect(migrateConfig({ schemaVersion: 9, x: 1 }).migrated).toBe(false);
	});

	it("runs each step in order, stamps the new version, and fails loudly on a missing step", () => {
		const migrations = {
			1: (c: Record<string, unknown>) => ({ ...c, renamed: c.old, old: undefined }),
			2: (c: Record<string, unknown>) => ({ ...c, step2: true }),
		};
		const result = migrateConfig({ old: "v" }, migrations, 3);
		expect(result.migrated).toBe(true);
		expect(result.config).toMatchObject({ renamed: "v", step2: true, schemaVersion: 3 });
		// A missing step fails loudly.
		expect(() => migrateConfig({}, {}, 2)).toThrow("No config migration from schema 1 to 2");
	});
});

describe("CLI value parsing", () => {
	it("parses by type and explains a bad value", () => {
		expect(parseCliValue(getFieldSpec("setupScript").type, "npm i && echo ok")).toBe("npm i && echo ok");
		expect(parseCliValue(getFieldSpec("peerReviewEnabled").type, "off")).toBe(false);
		expect(parseCliValue(getFieldSpec("portCount").type, "3")).toBe(3);
		expect(parseCliValue(getFieldSpec("clonePaths").type, "node_modules, .env")).toEqual(["node_modules", ".env"]);
		expect(parseCliValue(getFieldSpec("clonePaths").type, "[]")).toEqual([]);
		expect(parseCliValue(getFieldSpec("env").type, '{"A":"1"}')).toEqual({ A: "1" });
		// A bad value is explained.
		expect(() => parseCliValue(getFieldSpec("portCount").type, "two")).toThrow("expected an integer");
		expect(() => parseCliValue(getFieldSpec("env").type, "{bad")).toThrow("invalid JSON");
	});

	it("resolves dotted record paths and rejects the rest", () => {
		expect(resolveConfigPath("env.NODE_ENV")).toMatchObject({ key: "env", sub: "NODE_ENV", spec: { kind: "string" } });
		expect(() => resolveConfigPath("portCount.x")).toThrow("only record fields");
		expect(() => resolveConfigPath("setupScritp")).toThrow('Did you mean "setupScript"');
		// Unrelated words get no suggestion.
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
