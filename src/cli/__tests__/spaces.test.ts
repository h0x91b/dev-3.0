import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const HOME = vi.hoisted(() => `${process.env.DEV3_TEST_ROOT ?? tmpdir()}/cli-spaces-home`);

vi.mock("../../shared/user-home", () => ({
	resolveUserHome: () => HOME,
}));

import { readSpacesRaw, spaceFields } from "../spaces";

const DEV3 = `${HOME}/.dev3.0`;

function writeJson(name: string, value: unknown) {
	writeFileSync(`${DEV3}/${name}`, JSON.stringify(value));
}

beforeEach(() => {
	rmSync(HOME, { recursive: true, force: true });
	mkdirSync(DEV3, { recursive: true });
});

describe("readSpacesRaw", () => {
	it("returns the empty shape when spaces.json is absent or malformed", () => {
		expect(readSpacesRaw()).toEqual({ version: 1, spaces: [], order: [] });
		writeFileSync(`${DEV3}/spaces.json`, "not json");
		expect(readSpacesRaw()).toEqual({ version: 1, spaces: [], order: [] });
	});
});

describe("spaceFields", () => {
	it("returns nothing for a project with no memberships", () => {
		expect(spaceFields("p1")).toEqual([]);
	});

	it("groups siblings per space and carries each one's project id, skipping dangling ids", () => {
		writeJson("projects.json", [
			{ id: "p1", name: "api", path: "/dev/api" },
			{ id: "p2", name: "web", path: "/dev/web" },
			{ id: "p3", name: "infra", path: "/dev/infra" },
		]);
		writeJson("spaces.json", {
			version: 1,
			spaces: [
				{ id: "sp_1", name: "Client X", parentId: null, projectIds: ["p1", "p2", "ghost"], createdAt: 1 },
				{ id: "sp_2", name: "Platform", parentId: null, projectIds: ["p1", "p2", "p3"], createdAt: 1 },
			],
			order: ["sp_1", "sp_2"],
		});
		expect(spaceFields("p1")).toEqual([
			["Spaces:", "Client X, Platform"],
			["Siblings:", "[read-only]"],
			["  Client X:", "/dev/web (web, p2)"],
			["  Platform:", "/dev/web (web, p2), /dev/infra (infra, p3)"],
		]);
	});

	// The common case must stay as quiet as it was: one space, one flat line.
	it("keeps one flat Siblings line when the project belongs to a single space", () => {
		writeJson("projects.json", [
			{ id: "p1", name: "api", path: "/dev/api" },
			{ id: "p2", name: "web", path: "/dev/web" },
		]);
		writeJson("spaces.json", {
			version: 1,
			spaces: [{ id: "sp_1", name: "Client X", parentId: null, projectIds: ["p1", "p2"], createdAt: 1 }],
			order: ["sp_1"],
		});
		expect(spaceFields("p1")).toEqual([
			["Spaces:", "Client X"],
			["Siblings:", "/dev/web (web, p2) [read-only]"],
		]);
	});

	it("prints no Siblings block when every space holds only this project", () => {
		writeJson("projects.json", [{ id: "p1", name: "api", path: "/dev/api" }]);
		writeJson("spaces.json", {
			version: 1,
			spaces: [
				{ id: "sp_1", name: "Client X", parentId: null, projectIds: ["p1"], createdAt: 1 },
				{ id: "sp_2", name: "Platform", parentId: null, projectIds: ["p1"], createdAt: 1 },
			],
			order: ["sp_1", "sp_2"],
		});
		expect(spaceFields("p1")).toEqual([["Spaces:", "Client X, Platform"]]);
	});

	it("omits the Siblings line when the project is alone in its spaces", () => {
		writeJson("projects.json", [{ id: "p1", name: "api", path: "/dev/api" }]);
		writeJson("spaces.json", {
			version: 1,
			spaces: [{ id: "sp_1", name: "Solo", parentId: null, projectIds: ["p1"], createdAt: 1 }],
			order: ["sp_1"],
		});
		expect(spaceFields("p1")).toEqual([["Spaces:", "Solo"]]);
	});
});
