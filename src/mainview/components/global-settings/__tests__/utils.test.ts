import type { AgentConfiguration, ExternalApp } from "../../../../shared/types";
import {
	buildCommandPreview,
	normalizeExternalApps,
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
