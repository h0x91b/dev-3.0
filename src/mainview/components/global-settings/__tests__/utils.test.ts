import type { AgentConfiguration, ExternalApp } from "../../../../shared/types";
import {
	buildCommandPreview,
	moveItem,
	normalizeExternalApps,
	reorderToTarget,
	resolveTheme,
	toStoredDiffViewMode,
	toStoredTaskOpenMode,
} from "../utils";

describe("global-settings utils", () => {
	it("resolves system theme using OS preference", () => {
		expect(resolveTheme("system", true)).toBe("dark");
		expect(resolveTheme("system", false)).toBe("light");
		expect(resolveTheme("light", true)).toBe("light");
	});

	it("stores only non-default task and diff modes", () => {
		expect(toStoredTaskOpenMode("split")).toBeUndefined();
		expect(toStoredTaskOpenMode("fullscreen")).toBe("fullscreen");
		expect(toStoredDiffViewMode("split")).toBeUndefined();
		expect(toStoredDiffViewMode("unified")).toBe("unified");
	});

	it("filters incomplete external apps before persistence", () => {
		const apps: ExternalApp[] = [
			{ id: "1", name: "Finder", macAppName: "Finder" },
			{ id: "2", name: "  ", macAppName: "Cursor" },
			{ id: "3", name: "VS Code", macAppName: "" },
		];

		expect(normalizeExternalApps(apps)).toEqual([
			{ id: "1", name: "Finder", macAppName: "Finder" },
		]);
	});

	describe("moveItem", () => {
		it("moves an item up in the list", () => {
			expect(moveItem(["a", "b", "c", "d"], 2, 1)).toEqual([
				"a",
				"c",
				"b",
				"d",
			]);
		});

		it("moves an item down in the list", () => {
			expect(moveItem(["a", "b", "c", "d"], 1, 2)).toEqual([
				"a",
				"c",
				"b",
				"d",
			]);
		});

		it("returns the same reference when from === to", () => {
			const items = ["a", "b", "c"];
			expect(moveItem(items, 1, 1)).toBe(items);
		});

		it("ignores out-of-range indices", () => {
			const items = ["a", "b", "c"];
			expect(moveItem(items, -1, 0)).toBe(items);
			expect(moveItem(items, 3, 0)).toBe(items);
			expect(moveItem(items, 0, -1)).toBe(items);
			expect(moveItem(items, 0, 3)).toBe(items);
		});

		it("does not mutate the input array", () => {
			const items = ["a", "b", "c"];
			const result = moveItem(items, 0, 2);
			expect(items).toEqual(["a", "b", "c"]);
			expect(result).toEqual(["b", "c", "a"]);
		});
	});

	describe("reorderToTarget", () => {
		const items = [
			{ id: "a" },
			{ id: "b" },
			{ id: "c" },
			{ id: "d" },
		];
		const getId = (x: { id: string }) => x.id;

		it("inserts before target", () => {
			expect(reorderToTarget(items, "d", "b", "before", getId)).toEqual([
				{ id: "a" },
				{ id: "d" },
				{ id: "b" },
				{ id: "c" },
			]);
		});

		it("inserts after target", () => {
			expect(reorderToTarget(items, "a", "c", "after", getId)).toEqual([
				{ id: "b" },
				{ id: "c" },
				{ id: "a" },
				{ id: "d" },
			]);
		});

		it("returns unchanged when source equals target", () => {
			expect(reorderToTarget(items, "b", "b", "before", getId)).toBe(items);
		});

		it("returns unchanged when source is missing", () => {
			expect(reorderToTarget(items, "x", "b", "before", getId)).toBe(items);
		});
	});

	it("builds preview commands for Claude and Cursor-style agents", () => {
		const claudeConfig: AgentConfiguration = {
			id: "cfg-1",
			name: "Default",
			model: "sonnet",
			permissionMode: "plan",
			effort: "high",
			maxBudgetUsd: 5,
			additionalArgs: ["--verbose"],
			appendPrompt: "extra instructions",
			envVars: { FOO: "bar" },
		};
		const cursorConfig: AgentConfiguration = {
			id: "cfg-2",
			name: "Cursor",
			permissionMode: "bypassPermissions",
		};

		expect(buildCommandPreview("claude", claudeConfig)).toEqual({
			command:
				"claude --model sonnet --permission-mode plan --effort high --max-budget-usd 5 --append-system-prompt '…dev3 prompt…' --verbose '{{TASK_DESCRIPTION}}\\n\\nextra instructions'",
			envLine: "FOO=bar",
		});
		expect(buildCommandPreview("agent", cursorConfig)).toEqual({
			command:
				"agent --force '{{TASK_DESCRIPTION}}\\n\\n…dev3 prompt…'",
			envLine: null,
		});
	});
});
