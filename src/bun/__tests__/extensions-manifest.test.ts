import { describe, expect, it } from "vitest";
import {
	boardViewTelemetryId,
	extensionsEnvLock,
	normalizeExtensionsState,
	satisfiesRange,
	validateExtensionManifest,
} from "../../shared/extensions";

const valid = {
	id: "focus-list",
	name: "Focus list",
	version: "1.0.0",
	publisher: "Someone",
	engines: { dev3: "^1.0.0" },
	contributes: { boardViews: [{ id: "focus", label: "Focus list" }] },
	main: "index.js",
};

describe("validateExtensionManifest", () => {
	it("accepts a complete manifest and defaults main", () => {
		const { main: _main, ...withoutMain } = valid;
		const result = validateExtensionManifest(withoutMain, "focus-list");
		expect(result).toEqual({ ok: true, manifest: { ...valid } });
	});

	it.each([
		["a non-object", "nope", /not a JSON object/],
		["a reserved id", { ...valid, id: "builtin" }, /reserved/],
		["an id with a path", { ...valid, id: "../evil" }, /id must be/],
		["no publisher", { ...valid, publisher: " " }, /publisher/],
		["a non-semver version", { ...valid, version: "one" }, /version/],
		["no engines.dev3", { ...valid, engines: {} }, /engines\.dev3/],
		["another main file", { ...valid, main: "../../steal.js" }, /main must be/],
		["no views", { ...valid, contributes: { boardViews: [] } }, /at least one view/],
		["a duplicate view", { ...valid, contributes: { boardViews: [{ id: "a", label: "A" }, { id: "a", label: "B" }] } }, /listed twice/],
		["a view id with a colon", { ...valid, contributes: { boardViews: [{ id: "builtin:kanban", label: "K" }] } }, /each board view/],
	])("rejects %s", (_name, raw, error) => {
		const result = validateExtensionManifest(raw);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(error);
	});

	it("requires the install folder to carry the manifest id", () => {
		const result = validateExtensionManifest(valid, "other-name");
		expect(result.ok).toBe(false);
	});
});

describe("satisfiesRange (engines.dev3)", () => {
	it.each([
		["1.0.0", "^1.0.0", true],
		["1.4.2", "^1.0.0", true],
		["2.0.0", "^1.0.0", false],
		["1.0.0", "^2.0.0", false],
		["1.0.0", ">=1.0.0 <2.0.0", true],
		["1.0.0", "~1.1.0", false],
		["1.0.0", "1.x", true],
		["1.0.0", "*", true],
		["1.0.0", "^0.9.0 || ^1.0.0", true],
		["0.2.0", "^0.1.0", false],
		["1.0.0", "banana", false],
	])("%s against %s → %s", (version, range, expected) => {
		expect(satisfiesRange(version, range)).toBe(expected);
	});
});

describe("telemetry bucketing of board views (telemetry rule 1)", () => {
	it("keeps a built-in id", () => {
		expect(boardViewTelemetryId("builtin:kanban")).toBe("builtin:kanban");
		expect(boardViewTelemetryId("builtin:table")).toBe("builtin:table");
	});

	it("collapses every extension view to third_party, never its id or name", () => {
		for (const id of ["focus-list:focus", "acme-secret-project:board", "builtin-ish:x", "builtin:Evil Name", "builtin:a:b"]) {
			expect(boardViewTelemetryId(id)).toBe("third_party");
		}
	});
});

describe("extensions state file", () => {
	it("reads garbage as the safe default: everything on, nothing trusted", () => {
		expect(normalizeExtensionsState("garbage")).toEqual({ version: 1, disabledBuiltins: [], disabledExtensions: [], trust: {} });
	});

	it("keeps only toggleable built-ins and well-formed trust records", () => {
		const state = normalizeExtensionsState({
			enabled: false,
			disabledBuiltins: ["builtin:kanban", "builtin:table"],
			trust: { "focus-list": { publisher: "P", consentedAt: "2026-11-01" }, "../x": { publisher: "P", consentedAt: "t" }, bad: { publisher: 1 } },
		});
		expect(state.enabled).toBe(false);
		expect(state.disabledBuiltins).toEqual(["builtin:table"]);
		expect(Object.keys(state.trust)).toEqual(["focus-list"]);
	});

	it("treats DEV3_EXTENSIONS=off and its spellings as the env kill switch", () => {
		expect(extensionsEnvLock("off")).toBe(true);
		expect(extensionsEnvLock(" OFF ")).toBe(true);
		expect(extensionsEnvLock("0")).toBe(true);
		expect(extensionsEnvLock("on")).toBe(false);
		expect(extensionsEnvLock(undefined)).toBe(false);
	});
});
