import type { AgentConfiguration, ExternalApp } from "../../../../shared/types";
import {
	AUTO_DIFF_VIEW_WIDTH_THRESHOLD,
	buildCommandPreview,
	moveItem,
	normalizeExternalApps,
	reorderToTarget,
	resolveAutoDiffViewMode,
	resolveDiffViewMode,
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

	it("stores only non-default task open modes", () => {
		expect(toStoredTaskOpenMode("split")).toBeUndefined();
		expect(toStoredTaskOpenMode("fullscreen")).toBe("fullscreen");
	});

	it("stores diff view modes verbatim so 'auto' can be distinguished from unset", () => {
		expect(toStoredDiffViewMode("split")).toBe("split");
		expect(toStoredDiffViewMode("unified")).toBe("unified");
		expect(toStoredDiffViewMode("auto")).toBe("auto");
	});

	describe("resolveAutoDiffViewMode", () => {
		it("picks unified on laptop-sized screens", () => {
			// MacBook 14" Retina is 1512 CSS px wide, well below 1800
			expect(resolveAutoDiffViewMode(1512)).toBe("unified");
			expect(resolveAutoDiffViewMode(1280)).toBe("unified");
			expect(resolveAutoDiffViewMode(1728)).toBe("unified");
			expect(resolveAutoDiffViewMode(AUTO_DIFF_VIEW_WIDTH_THRESHOLD - 1)).toBe(
				"unified",
			);
		});

		it("picks split on external-monitor-sized screens", () => {
			expect(resolveAutoDiffViewMode(AUTO_DIFF_VIEW_WIDTH_THRESHOLD)).toBe(
				"split",
			);
			expect(resolveAutoDiffViewMode(1920)).toBe("split");
			expect(resolveAutoDiffViewMode(2560)).toBe("split");
			expect(resolveAutoDiffViewMode(3840)).toBe("split");
		});
	});

	describe("resolveDiffViewMode", () => {
		it("honours explicit preferences regardless of screen size", () => {
			expect(resolveDiffViewMode("split", 1280)).toBe("split");
			expect(resolveDiffViewMode("unified", 3840)).toBe("unified");
		});

		it("falls back to auto when preference is undefined", () => {
			expect(resolveDiffViewMode(undefined, 1512)).toBe("unified");
			expect(resolveDiffViewMode(undefined, 2560)).toBe("split");
		});

		it("treats 'auto' explicitly the same as undefined", () => {
			expect(resolveDiffViewMode("auto", 1512)).toBe("unified");
			expect(resolveDiffViewMode("auto", 2560)).toBe("split");
		});
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
				"claude --model sonnet --permission-mode plan --allow-dangerously-skip-permissions --effort high --max-budget-usd 5 --append-system-prompt '…dev3 prompt…' --verbose '{{TASK_DESCRIPTION}}\\n\\nextra instructions'",
			envLine: "FOO=bar",
		});
		expect(buildCommandPreview("agent", cursorConfig)).toEqual({
			command:
				"agent --force '{{TASK_DESCRIPTION}}\\n\\n…dev3 prompt…'",
			envLine: null,
		});
	});

	it("omits --model for Claude when provider is bedrock", () => {
		const config: AgentConfiguration = {
			id: "c",
			name: "Default",
			model: "claude-opus-4-8[1m]",
		};
		expect(buildCommandPreview("claude", config, "bedrock").command).not.toContain("--model");
	});

	it("keeps --model for Claude on the anthropic provider (default)", () => {
		const config: AgentConfiguration = {
			id: "c",
			name: "Default",
			model: "claude-opus-4-8[1m]",
		};
		expect(buildCommandPreview("claude", config, "anthropic").command).toContain(
			"--model 'claude-opus-4-8[1m]'",
		);
		// No provider arg → unchanged (back-compat)
		expect(buildCommandPreview("claude", config).command).toContain("--model");
	});

	it("does not affect non-Claude agents under a provider", () => {
		const config: AgentConfiguration = { id: "c", name: "Codex", model: "gpt-5.5" };
		expect(buildCommandPreview("codex", config, "bedrock").command).toContain("--model gpt-5.5");
	});

	it("surfaces the injected provider env in the preview env line", () => {
		const config: AgentConfiguration = {
			id: "c",
			name: "Default",
			model: "claude-opus-4-8[1m]",
		};
		const { envLine } = buildCommandPreview("claude", config, "bedrock");
		expect(envLine).toContain("CLAUDE_CODE_USE_BEDROCK=1");
		expect(envLine).toContain("ANTHROPIC_MODEL=global.anthropic.claude-opus-4-8[1m]");
	});

	it("provider env respects the selected geo and model overrides", () => {
		const config: AgentConfiguration = {
			id: "c",
			name: "Default",
			model: "claude-opus-4-8[1m]",
		};
		const { envLine } = buildCommandPreview("claude", config, "bedrock", {
			bedrock: {
				geo: "eu",
				modelOverrides: { "claude-opus-4-8[1m]": "arn:aws:bedrock:custom" },
			},
		});
		expect(envLine).toContain("ANTHROPIC_MODEL=arn:aws:bedrock:custom");
	});

	it("config envVars win over provider env in the preview", () => {
		const config: AgentConfiguration = {
			id: "c",
			name: "Default",
			model: "claude-opus-4-8[1m]",
			envVars: { ANTHROPIC_MODEL: "my-manual-model" },
		};
		const { envLine } = buildCommandPreview("claude", config, "bedrock");
		expect(envLine).toContain("ANTHROPIC_MODEL=my-manual-model");
		expect(envLine).toContain("CLAUDE_CODE_USE_BEDROCK=1");
	});

	it("keeps the env line free of provider vars on the anthropic default", () => {
		const config: AgentConfiguration = {
			id: "c",
			name: "Default",
			model: "claude-opus-4-8[1m]",
		};
		expect(buildCommandPreview("claude", config, "anthropic").envLine).toBeNull();
	});
});
