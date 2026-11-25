import { describe, it, expect } from "vitest";
import { hasCommandHelp, getCommandHelp, renderHelp, resolveHelp } from "../help";

describe("hasCommandHelp", () => {
	it("knows registered commands", () => {
		expect(hasCommandHelp("task")).toBe(true);
		expect(hasCommandHelp("note")).toBe(true);
		expect(hasCommandHelp("vents")).toBe(true);
		expect(hasCommandHelp("bogus")).toBe(false);
		// remote/gui render their own help inside their handlers and are
		// intentionally absent from the registry.
		expect(hasCommandHelp("remote")).toBe(false);
		expect(hasCommandHelp("gui")).toBe(false);
	});
});

describe("renderHelp — group listing", () => {
	it("lists every subcommand for a group command", () => {
		const out = renderHelp("task")!;
		expect(out).toContain("dev3 task — Inspect and manage individual tasks.");
		expect(out).toContain("Subcommands:");
		for (const name of ["show", "create", "update", "move"]) {
			expect(out).toContain(`dev3 task ${name}`);
		}
		expect(out).toContain('Run "dev3 task <subcommand> --help" for details');
		expect(out).toContain("Global options:");
		expect(renderHelp("task", "frobnicate"), "unknown subcommand falls back to the listing").toBe(out);
		expect(renderHelp("bogus")).toBeNull();
		expect(renderHelp("bogus", "sub")).toBeNull();
	});
});

describe("renderHelp — subcommand detail", () => {
	it("documents model/effort preset selection without an account flag", () => {
		const out = renderHelp("agent", "spawn")!;
		expect(out).toContain("--config <id>   Model/effort preset");
		expect(out).toContain("default account");
		expect(out).not.toContain("--account");
	});

	it("renders the targeted subcommand's usage and details", () => {
		const out = renderHelp("task", "create")!;
		expect(out).toContain("dev3 task create — Create a task in To Do, or ask the user to start a scratch peer agent.");
		expect(out).toContain("Usage:");
		expect(out).toContain('dev3 task create --title "..." [--description "..." | --description -]');
		expect(out).toContain("--title <text>");
		expect(out).toContain("read it from stdin");
		expect(out).toContain("Global options:");
	});

	it("renders a subcommand without details (no empty Details block)", () => {
		const out = renderHelp("note", "list")!;
		expect(out).toContain("dev3 note list — List a task's notes");
		expect(out).not.toContain("Details:");
	});

	it("documents stdin for supported long-text fields", () => {
		expect(renderHelp("task", "update")).toContain("--description -");
		expect(renderHelp("note", "add")).toContain("--content -");
		expect(renderHelp("automations", "create")).toContain("--prompt -");
		expect(renderHelp("automations", "update")).toContain("--prompt -");
	});
});

describe("renderHelp — leaf command", () => {
	it("renders usage/details directly for a leaf command", () => {
		const out = renderHelp("vents")!;
		expect(out).toContain("dev3 vents — File anonymous dev3-platform feedback");
		expect(out).toContain("Usage:");
		expect(out).toContain('dev3 vents "short name" "markdown body"');
		// A leaf command has no subcommand listing.
		expect(out).not.toContain("Subcommands:");
		expect(renderHelp("vents", "whatever")).toEqual(renderHelp("vents"));
	});
});

describe("resolveHelp — routing decision", () => {

	it("ignores --help after a bare -- : it belongs to the script", () => {
		expect(resolveHelp(["dev-server", "start", "--", "--help"])).toEqual({ action: "none" });
		expect(resolveHelp(["dev-server", "start", "--help", "--", "-h"]).action).toBe("command");
	});

	it("no args, bare --help, or an unknown '<command> --help' → top-level help", () => {
		expect(resolveHelp([])).toEqual({ action: "top" });
		expect(resolveHelp(["bogus", "--help"])).toEqual({ action: "top" });
		expect(resolveHelp(["--help"])).toEqual({ action: "top" });
		expect(resolveHelp(["-h"])).toEqual({ action: "top" });
	});

	it("'<command> [<subcommand>] --help' → that command's help text", () => {
		expect(resolveHelp(["task", "--help"])).toEqual({ action: "command", text: renderHelp("task") });
		expect(resolveHelp(["task", "create", "--help"])).toEqual({ action: "command", text: renderHelp("task", "create") });
	});

	it("remote/gui --help and a real invocation are not help requests (none)", () => {
		expect(resolveHelp(["remote", "--help"])).toEqual({ action: "none" });
		expect(resolveHelp(["gui", "--help"])).toEqual({ action: "none" });
		expect(resolveHelp(["task", "create", "--title", "x"])).toEqual({ action: "none" });
	});
});

describe("registry coverage", () => {
	// Every command dispatched in main.ts (except remote/gui, which own their
	// help) must have a registry entry so `dev3 <cmd> --help` works.
	const dispatched = [
		"current",
		"install-hooks",
		"install-skills",
		"conversations",
		"projects",
		"spaces",
		"tasks",
		"task",
		"note",
		"vents",
		"overview",
		"label",
		"config",
		"dev-server",
		"pr",
	];

	it("every dispatched command and subcommand renders help", () => {
		for (const cmd of dispatched) {
			expect(hasCommandHelp(cmd), cmd).toBe(true);
			expect(renderHelp(cmd), cmd).not.toBeNull();
			const spec = getCommandHelp(cmd)!;
			for (const sub of spec.subcommands) {
				const out = renderHelp(cmd, sub.name)!;
				expect(out).toContain(`dev3 ${cmd} ${sub.name} —`);
				expect(out).toContain(sub.usage);
			}
		}
	});
});

// `dev3 project list` used to die with "Unknown command: project" and no hint,
// so the reader concluded the feature did not exist. main.ts forwards the
// singular to `projects`; the help registry has to agree.
describe("the singular `project` alias", () => {
	it("resolves help to the plural projects command", () => {
		expect(hasCommandHelp("project")).toBe(true);
		expect(getCommandHelp("project")).toBe(getCommandHelp("projects"));
		expect(renderHelp("project", "list")).toContain("dev3 projects list");
		expect(getCommandHelp("space")).toBe(getCommandHelp("spaces"));
	});
});

describe("projects / spaces help", () => {
	it("names the duplicate and space-ref exit codes on projects add", () => {
		const out = renderHelp("projects", "add")!;
		expect(out).toContain("exits 33");
		expect(out).toContain("exit 34");
		expect(out).toContain("dev3 projects clone <url>");
		expect(renderHelp("spaces", "set")).toContain("REPLACE");
	});
});

describe("pr create help", () => {
	it("names the gh precondition, its exit code, and the auto-merge strategies", () => {
		const out = renderHelp("pr", "create")!;
		expect(out).toContain("--auto-merge");
		expect(out).toContain("squash");
		expect(out).toContain("exits 23");
	});
});

describe("tasks list help", () => {
	it("documents the priority column, the filter and the sort key", () => {
		const out = renderHelp("tasks", "list")!;
		expect(out).toContain("--priority");
		expect(out).toContain("--sort priority|seq");
		expect(out).toContain("PRI column");
	});
});
