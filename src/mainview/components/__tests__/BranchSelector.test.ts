import { describe, it, expect, vi } from "vitest";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			listBranches: vi.fn(),
			fetchBranches: vi.fn(),
		},
	},
}));

vi.mock("../../analytics", () => ({
	trackEvent: vi.fn(),
}));

import { parseForkRef, matchesBranchQuery, splitBranchWords } from "../BranchSelector";

// ─── parseForkRef ────────────────────────────────────────────────────────────

describe("parseForkRef", () => {
	it("parses valid fork reference", () => {
		const result = parseForkRef("yanive:feat/cross-project-activity-tab");
		expect(result).toEqual({
			forkOwner: "yanive",
			branchName: "feat/cross-project-activity-tab",
		});
	});

	it("parses fork reference with simple branch", () => {
		const result = parseForkRef("user123:main");
		expect(result).toEqual({
			forkOwner: "user123",
			branchName: "main",
		});
	});

	it("parses fork reference with hyphens and underscores in owner", () => {
		const result = parseForkRef("my-user_name:fix/something");
		expect(result).toEqual({
			forkOwner: "my-user_name",
			branchName: "fix/something",
		});
	});

	it("returns null for plain branch name", () => {
		expect(parseForkRef("feat/some-feature")).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(parseForkRef("")).toBeNull();
	});

	it("returns null for colon at start", () => {
		expect(parseForkRef(":branch-name")).toBeNull();
	});

	it("returns null for plain text without colon", () => {
		expect(parseForkRef("just-a-branch")).toBeNull();
	});
});

// ─── splitBranchWords ────────────────────────────────────────────────────────

describe("splitBranchWords", () => {
	it("splits on slashes", () => {
		expect(splitBranchWords("feat/login-page")).toEqual(["feat", "login", "page"]);
	});

	it("splits camelCase", () => {
		expect(splitBranchWords("myFeatureBranch")).toEqual(["my", "feature", "branch"]);
	});
});

// ─── matchesBranchQuery ─────────────────────────────────────────────────────

describe("matchesBranchQuery", () => {
	it("matches empty query to any branch", () => {
		expect(matchesBranchQuery("feat/login", "")).toBe(true);
	});

	it("matches word prefix", () => {
		expect(matchesBranchQuery("feat/login-page", "log")).toBe(true);
	});

	it("does not match mid-word", () => {
		expect(matchesBranchQuery("feat/login-page", "ogin")).toBe(false);
	});

	it("matches slash-containing query via substring fallback", () => {
		expect(matchesBranchQuery("origin/feat/login", "origin/feat")).toBe(true);
	});
});
