import { describe, it, expect, vi } from "vitest";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			listBranches: vi.fn(),
			fetchBranches: vi.fn(),
			resolvePrUrl: vi.fn(),
		},
	},
}));

vi.mock("../../analytics", () => ({
	trackEvent: vi.fn(),
}));

import { parseForkRef, parsePrUrl, normalizeBranchQuery, matchesBranchQuery, splitBranchWords, sortBranchesForDisplay } from "../BranchSelector";

// ─── parsePrUrl ──────────────────────────────────────────────────────────────

describe("parsePrUrl", () => {
	it("parses a plain github.com PR URL", () => {
		expect(parsePrUrl("https://github.com/h0x91b/dev-3.0/pull/42")).toEqual({
			url: "https://github.com/h0x91b/dev-3.0/pull/42",
			number: 42,
		});
	});

	it("parses a PR URL with a /files suffix", () => {
		expect(parsePrUrl("https://github.com/owner/repo/pull/7/files")).toEqual({
			url: "https://github.com/owner/repo/pull/7/files",
			number: 7,
		});
	});

	it("parses a PR URL with a query string and hash", () => {
		expect(parsePrUrl("https://github.com/owner/repo/pull/123?w=1#discussion")).toEqual({
			url: "https://github.com/owner/repo/pull/123?w=1#discussion",
			number: 123,
		});
	});

	it("extracts a PR URL embedded in surrounding text", () => {
		const result = parsePrUrl("please review https://github.com/o/r/pull/9 thanks");
		expect(result).toEqual({ url: "https://github.com/o/r/pull/9", number: 9 });
	});

	it("supports GitHub Enterprise hosts", () => {
		expect(parsePrUrl("https://ghe.corp.example/team/app/pull/5")).toEqual({
			url: "https://ghe.corp.example/team/app/pull/5",
			number: 5,
		});
	});

	it("returns null for a non-PR github URL", () => {
		expect(parsePrUrl("https://github.com/owner/repo/issues/42")).toBeNull();
	});

	it("returns null for a plain branch name", () => {
		expect(parsePrUrl("feat/some-feature")).toBeNull();
	});

	it("returns null for an empty string", () => {
		expect(parsePrUrl("")).toBeNull();
	});
});

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

describe("normalizeBranchQuery", () => {
	it("normalizes fork refs to remote-style slashes", () => {
		expect(normalizeBranchQuery("roiros:feat/collapsible-kanban-columns")).toBe("roiros/feat/collapsible-kanban-columns");
	});

	it("trims surrounding whitespace", () => {
		expect(normalizeBranchQuery("  origin/main  ")).toBe("origin/main");
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

	it("matches fork ref with colon by normalizing to slash", () => {
		expect(matchesBranchQuery("roiros/feat/collapsible-kanban-columns", "roiros:feat/collapsible-kanban-columns")).toBe(true);
	});

	it("matches partial fork ref with colon", () => {
		expect(matchesBranchQuery("roiros/feat/collapsible-kanban-columns", "roiros:feat")).toBe(true);
	});

	it("matches a query that contains a dash spanning word boundaries", () => {
		expect(matchesBranchQuery("feat/login-page", "login-page")).toBe(true);
	});

	it("matches a multi-word dashed query against a dashed branch", () => {
		expect(matchesBranchQuery("sworgkh/fix/dev3-tmux-switch-glitch", "dev3-tmux")).toBe(true);
	});

	it("matches a dashed query with underscore/dot separators in the branch", () => {
		expect(matchesBranchQuery("feat/login_page", "login-page")).toBe(true);
	});

	it("keeps matching while the user is mid-typing a trailing dash", () => {
		expect(matchesBranchQuery("feat/dev3-auth", "dev3-")).toBe(true);
	});
});

describe("sortBranchesForDisplay", () => {
	it("prioritizes fetched fork branches and remote refs in review-heavy flows", () => {
		const result = sortBranchesForDisplay([
			{ name: "feature/local-work", isRemote: false },
			{ name: "origin/main", isRemote: true },
			{ name: "sworgkh/fix/dev3-tmux-switch-glitch", isRemote: true },
			{ name: "yanive/feat/cross-project-activity-tab", isRemote: true },
		], {
			preferRemote: true,
			prioritizedBranchNames: ["sworgkh/fix/dev3-tmux-switch-glitch"],
		});

		expect(result.map((branch) => branch.name)).toEqual([
			"sworgkh/fix/dev3-tmux-switch-glitch",
			"yanive/feat/cross-project-activity-tab",
			"origin/main",
			"feature/local-work",
		]);
	});
});
