import { describe, expect, it } from "vitest";
import type { Project, Space, SpacesFile } from "../../shared/types";
import {
	cloneDirNameProblem,
	looksLikeGitUrl,
	resolveSpaceRef,
	shortSpaceId,
	spaceNamed,
	spaceRefProblem,
	toCliProject,
	toCliSpaces,
} from "../../shared/project-registration";

function space(id: string, name: string, projectIds: string[], extra: Partial<Space> = {}): Space {
	return { id, name, parentId: null, projectIds, createdAt: 1, ...extra };
}

function project(id: string, name: string, extra: Partial<Project> = {}): Project {
	return {
		id,
		name,
		path: `/repos/${name}`,
		setupScript: "",
		devScript: "",
		cleanupScript: "",
		defaultBaseBranch: "main",
		createdAt: "2026-10-18T00:00:00Z",
		...extra,
	};
}

const WORK = space("sp_11111111-aaaa-bbbb-cccc-000000000001", "Work / Side", ["p1", "p2"]);
const PERSONAL = space("sp_22222222-aaaa-bbbb-cccc-000000000002", "Personal", ["p2"]);
const GONE = space("sp_33333333-aaaa-bbbb-cccc-000000000003", "Archive", ["p1"], { deleted: true });
const FILE: SpacesFile = { version: 1, spaces: [WORK, PERSONAL, GONE], order: [PERSONAL.id, WORK.id] };

describe("looksLikeGitUrl", () => {
	it("treats remote URLs as URLs and local paths as paths", () => {
		for (const url of [
			"https://example.com/group/repo",
			"https://example.com/group/repo.git",
			"ssh://git@example.com/group/repo.git",
			"git@example.com:group/repo.git",
			"file:///srv/repo.git",
		]) expect(looksLikeGitUrl(url), url).toBe(true);
		for (const path of ["/Users/me/repo", "~/dev/repo", "./repo", "repo", "C:\\Users\\me\\repo", "C:/Users/me/repo"]) {
			expect(looksLikeGitUrl(path), path).toBe(false);
		}
	});
});

describe("cloneDirNameProblem", () => {
	it("accepts a plain folder name and refuses URLs and unsafe names", () => {
		expect(cloneDirNameProblem("notes-app")).toBeNull();
		expect(cloneDirNameProblem("my repo")).toBeNull();
		// The shape that produced a project at `<base>/https://host/group/repo`.
		expect(cloneDirNameProblem("https://example.com/group/notes-app")).toMatch(/is a URL/);
		for (const name of ["", "  ", ".", "..", "group/repo", "group\\repo", "bad\u0000name"]) {
			expect(cloneDirNameProblem(name), JSON.stringify(name)).not.toBeNull();
		}
	});
});

describe("resolveSpaceRef", () => {
	it("matches a full id, the short id `spaces list` prints, or a trimmed case-insensitive name", () => {
		expect(resolveSpaceRef(FILE.spaces, WORK.id)).toEqual({ ok: true, space: WORK });
		expect(resolveSpaceRef(FILE.spaces, shortSpaceId(WORK.id))).toEqual({ ok: true, space: WORK });
		expect(resolveSpaceRef(FILE.spaces, "  work / side ")).toEqual({ ok: true, space: WORK });
	});

	it("never matches a deleted space, a substring, or an id prefix too short to be safe", () => {
		expect(resolveSpaceRef(FILE.spaces, "Archive")).toEqual({ ok: false, reason: "not-found", candidates: [] });
		expect(resolveSpaceRef(FILE.spaces, GONE.id).ok).toBe(false);
		expect(resolveSpaceRef(FILE.spaces, "WORK").ok).toBe(false);
		expect(resolveSpaceRef(FILE.spaces, "sp_1111").ok).toBe(false);
	});

	it("reports a name two spaces share as ambiguous", () => {
		const twin = space("sp_44444444-aaaa-bbbb-cccc-000000000004", "personal", ["p3"]);
		const result = resolveSpaceRef([...FILE.spaces, twin], "Personal");
		expect(result).toEqual({ ok: false, reason: "ambiguous", candidates: [PERSONAL, twin] });
	});
});

describe("spaceRefProblem", () => {
	it("lists the existing spaces with their short ids, or says there are none", () => {
		const result = resolveSpaceRef(FILE.spaces, "Nope");
		if (result.ok) throw new Error("expected a miss");
		const message = spaceRefProblem(FILE, "Nope", result);
		expect(message).toContain('No space matches "Nope"');
		expect(message).toContain('"Personal" (sp_22222222)');
		expect(message).toContain('"Work / Side" (sp_11111111)');
		expect(message).not.toContain("Archive");

		// With no spaces at all, it says so.
		const empty: SpacesFile = { version: 1, spaces: [], order: [] };
		const emptyResult = resolveSpaceRef(empty.spaces, "X");
		if (emptyResult.ok) throw new Error("expected a miss");
		expect(spaceRefProblem(empty, "X", emptyResult)).toContain("no spaces yet");
	});
});

describe("spaceNamed", () => {
	it("finds an active space by name, ignoring deleted ones", () => {
		expect(spaceNamed(FILE, "personal")).toBe(PERSONAL);
		expect(spaceNamed(FILE, "Archive")).toBeUndefined();
	});
});

describe("toCliProject / toCliSpaces", () => {
	it("lists a project's spaces in display order, marking virtual boards and skipping deleted spaces", () => {
		expect(toCliProject(project("p2", "api"), FILE)).toEqual({
			id: "p2",
			name: "api",
			path: "/repos/api",
			kind: "git",
			defaultBaseBranch: "main",
			gitWorkflow: true,
			spaces: [
				{ id: PERSONAL.id, name: "Personal" },
				{ id: WORK.id, name: "Work / Side" },
			],
		});

		// A virtual board is marked, and deleted spaces are skipped.
		const info = toCliProject(project("p1", "ops", { kind: "virtual" }), FILE);
		expect(info.kind).toBe("virtual");
		expect(info.gitWorkflow).toBe(false);
		expect(toCliProject(project("p3", "notes", { gitWorkflow: false }), FILE).gitWorkflow).toBe(false);
		expect(info.spaces.map((s) => s.name)).toEqual(["Work / Side"]);
	});

	it("names each space's members and skips ids this machine does not know", () => {
		const spaces = toCliSpaces(FILE, [project("p2", "api"), project("p1", "web", { deleted: true })]);
		expect(spaces.map((s) => s.name)).toEqual(["Personal", "Work / Side"]);
		expect(spaces[1].projects).toEqual([{ id: "p2", name: "api", path: "/repos/api" }]);
		expect(spaces[1].sensitive).toBe(false);
	});
});
