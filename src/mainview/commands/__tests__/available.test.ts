import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { availableCommands as filterCommands } from "../available";
import { BUILTIN_COMMANDS_PLUGIN } from "../builtins";
import { getCommandsRegistry, type CommandContext } from "../registry";
import { applyBuiltinPlugins } from "../../plugins/runtime";
import { setAgentTrafficEnabledForTests } from "../../agent-traffic-flag";
import { shortcutById } from "../../keymap";

const registered = () => getCommandsRegistry().list().map((entry) => entry.def);
const availableCommands = (ctx: CommandContext) => filterCommands(registered(), ctx);

describe("availableCommands", () => {
	beforeAll(() => applyBuiltinPlugins([], [BUILTIN_COMMANDS_PLUGIN]));
	// Scope is the axis under test; the agent-traffic beta is a second axis with
	// its own suite, so its feature is on here to compare full registries.
	beforeEach(() => setAgentTrafficEnabledForTests(true));

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
		expect(cmds).toHaveLength(registered().length);
	});

	it("preserves registry order", () => {
		const cmds = availableCommands({ hasProject: true, hasTask: true });
		expect(cmds.map((c) => c.id)).toEqual(registered().map((c) => c.id));
	});

	it("never exposes destructive lifecycle commands (complete/cancel/delete) in the quick palette", () => {
		const ids = registered().map((c) => c.id);
		expect(ids).not.toContain("builtin:task-mark-completed");
		expect(ids).not.toContain("builtin:task-mark-cancelled");
		expect(ids).not.toContain("builtin:task-delete");
	});

	it("lists one Board view command per offered view right after Go to board, project scope only", () => {
		const boardViews = [{ id: "builtin:kanban", name: "Kanban" }, { id: "acme:gantt", name: "Gantt" }];
		const ids = availableCommands({ hasProject: true, hasTask: false, boardViews }).map((c) => c.id);
		const at = ids.indexOf("builtin:view-board");
		expect(ids.slice(at, at + 3)).toEqual(["builtin:view-board", "view-board:builtin:kanban", "view-board:acme:gantt"]);
		const gantt = availableCommands({ hasProject: true, hasTask: false, boardViews }).find((c) => c.id === "view-board:acme:gantt");
		expect(gantt).toMatchObject({ labelKey: "command.boardView", labelVars: { name: "Gantt" } });
		expect(availableCommands({ hasProject: false, hasTask: false, boardViews }).some((c) => c.id.startsWith("view-board:"))).toBe(false);
	});

	it("gives every command a unique id", () => {
		const ids = registered().map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("hides git, dev-server, run-script, and project-terminal commands for a virtual (Operations) project", () => {
		const cmds = availableCommands({ hasProject: true, hasTask: true, isVirtual: true });
		const ids = cmds.map((c) => c.id);
		expect(cmds.some((c) => c.category === "git")).toBe(false);
		expect(cmds.some((c) => c.category === "devserver")).toBe(false);
		expect(ids).not.toContain("builtin:task-run-script");
		// Project terminal would throw "Project path does not exist" on a virtual
		// board (its synthetic path is created lazily per-task) — hide it too.
		expect(ids).not.toContain("builtin:term-toggle-project-terminal");
		// Quick shell stays — it's the entry point INTO the Operations board.
		expect(ids).toContain("builtin:term-open-quick-shell");
		// Non-git task commands stay available.
		expect(ids).toContain("builtin:task-open-in-finder");
		expect(ids).toContain("builtin:task-move-in-progress");
	});

	it("keeps git/dev-server/run-script/project-terminal commands for a normal (git) project", () => {
		const cmds = availableCommands({ hasProject: true, hasTask: true, isVirtual: false });
		expect(cmds.some((c) => c.category === "git")).toBe(true);
		expect(cmds.some((c) => c.category === "devserver")).toBe(true);
		expect(cmds.map((c) => c.id)).toContain("builtin:task-run-script");
		expect(cmds.map((c) => c.id)).toContain("builtin:term-toggle-project-terminal");
	});

	it("hides only git and import commands when the project's git workflow is off", () => {
		const cmds = availableCommands({ hasProject: true, hasTask: true, gitless: true });
		const ids = cmds.map((c) => c.id);
		expect(cmds.some((c) => c.category === "git")).toBe(false);
		expect(cmds.some((c) => c.category === "import")).toBe(false);
		// The folder is real, so its terminal, scripts and dev server stay.
		expect(cmds.some((c) => c.category === "devserver")).toBe(true);
		expect(ids).toContain("builtin:task-run-script");
		expect(ids).toContain("builtin:term-toggle-project-terminal");
	});

	it("hides host-local 'Open in Finder' in browser remote mode", () => {
		const desktop = availableCommands({ hasProject: true, hasTask: true });
		expect(desktop.map((c) => c.id)).toContain("builtin:task-open-in-finder");
		const remote = availableCommands({ hasProject: true, hasTask: true, remote: true });
		expect(remote.map((c) => c.id)).not.toContain("builtin:task-open-in-finder");
		// Only that one command is dropped vs desktop.
		expect(remote.length).toBe(desktop.length - 1);
	});

	it("offers Find coordinator everywhere, with no project open", () => {
		const ids = availableCommands({ hasProject: false, hasTask: false }).map((c) => c.id);
		expect(ids).toContain("builtin:find-coordinator");
	});

	it("drops only the command whose visibility rule throws", () => {
		const boom = { ...registered()[0], id: "x:boom", when: () => { throw new Error("boom"); } };
		const ctx = { hasProject: true, hasTask: true };
		const ids = filterCommands([boom, ...registered()], ctx).map((c) => c.id);
		expect(ids).not.toContain("x:boom");
		expect(ids).toHaveLength(availableCommands(ctx).length);
	});
});

describe("command shortcuts", () => {
	beforeAll(() => applyBuiltinPlugins([], [BUILTIN_COMMANDS_PLUGIN]));

	it("every shortcutId names a real keymap entry", () => {
		const linked = registered().filter((c) => c.shortcutId);
		expect(linked.length).toBeGreaterThan(0);
		for (const command of linked) expect(shortcutById(command.shortcutId!), command.id).toBeDefined();
	});
});
