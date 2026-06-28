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

	it("hides git, dev-server, run-script, and project-terminal commands for a virtual (Operations) project", () => {
		const cmds = availableCommands({ hasProject: true, hasTask: true, isVirtual: true });
		const ids = cmds.map((c) => c.id);
		expect(cmds.some((c) => c.category === "git")).toBe(false);
		expect(cmds.some((c) => c.category === "devserver")).toBe(false);
		expect(ids).not.toContain("task-run-script");
		// Project terminal would throw "Project path does not exist" on a virtual
		// board (its synthetic path is created lazily per-task) — hide it too.
		expect(ids).not.toContain("term-toggle-project-terminal");
		// Quick shell stays — it's the entry point INTO the Operations board.
		expect(ids).toContain("term-open-quick-shell");
		// Non-git task commands stay available.
		expect(ids).toContain("task-open-in-finder");
		expect(ids).toContain("task-move-in-progress");
	});

	it("keeps git/dev-server/run-script/project-terminal commands for a normal (git) project", () => {
		const cmds = availableCommands({ hasProject: true, hasTask: true, isVirtual: false });
		expect(cmds.some((c) => c.category === "git")).toBe(true);
		expect(cmds.some((c) => c.category === "devserver")).toBe(true);
		expect(cmds.map((c) => c.id)).toContain("task-run-script");
		expect(cmds.map((c) => c.id)).toContain("term-toggle-project-terminal");
	});

	it("hides host-local 'Open in Finder' in browser remote mode", () => {
		const desktop = availableCommands({ hasProject: true, hasTask: true });
		expect(desktop.map((c) => c.id)).toContain("task-open-in-finder");
		const remote = availableCommands({ hasProject: true, hasTask: true, remote: true });
		expect(remote.map((c) => c.id)).not.toContain("task-open-in-finder");
		// Only that one command is dropped vs desktop.
		expect(remote.length).toBe(desktop.length - 1);
	});
});
