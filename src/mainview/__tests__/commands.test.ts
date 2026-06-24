import { describe, expect, it } from "vitest";
import { ALL_COMMANDS, availableCommands } from "../commands";

describe("availableCommands", () => {
	it("with no project and no task, returns only always-scoped commands", () => {
		const cmds = availableCommands({ hasProject: false, hasTask: false });
		expect(cmds.length).toBeGreaterThan(0);
		expect(cmds.every((c) => c.scope === "always")).toBe(true);
	});

	it("with a project but no task, includes project-scoped but excludes task-scoped", () => {
		const cmds = availableCommands({ hasProject: true, hasTask: false });
		expect(cmds.some((c) => c.scope === "project")).toBe(true);
		expect(cmds.some((c) => c.scope === "task")).toBe(false);
	});

	it("with a task, includes every command (task implies the widest scope)", () => {
		const cmds = availableCommands({ hasProject: true, hasTask: true });
		expect(cmds).toHaveLength(ALL_COMMANDS.length);
	});

	it("preserves registry order", () => {
		const cmds = availableCommands({ hasProject: true, hasTask: true });
		expect(cmds.map((c) => c.id)).toEqual(ALL_COMMANDS.map((c) => c.id));
	});

	it("never exposes destructive lifecycle commands (complete/cancel/delete) in the quick palette", () => {
		const ids = ALL_COMMANDS.map((c) => c.id);
		expect(ids).not.toContain("task-mark-completed");
		expect(ids).not.toContain("task-mark-cancelled");
		expect(ids).not.toContain("task-delete");
	});

	it("gives every command a unique id", () => {
		const ids = ALL_COMMANDS.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("hides git, dev-server, and run-script commands for a virtual (Operations) project", () => {
		const cmds = availableCommands({ hasProject: true, hasTask: true, isVirtual: true });
		const ids = cmds.map((c) => c.id);
		expect(cmds.some((c) => c.category === "git")).toBe(false);
		expect(cmds.some((c) => c.category === "devserver")).toBe(false);
		expect(ids).not.toContain("task-run-script");
		// Non-git task commands stay available.
		expect(ids).toContain("task-open-in-finder");
		expect(ids).toContain("task-move-in-progress");
	});

	it("keeps git/dev-server/run-script commands for a normal (git) project", () => {
		const cmds = availableCommands({ hasProject: true, hasTask: true, isVirtual: false });
		expect(cmds.some((c) => c.category === "git")).toBe(true);
		expect(cmds.some((c) => c.category === "devserver")).toBe(true);
		expect(cmds.map((c) => c.id)).toContain("task-run-script");
	});
});
