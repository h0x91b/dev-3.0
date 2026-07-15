import { describe, it, expect } from "vitest";
import { hasCommandHelp, getCommandHelp, renderHelp, resolveHelp } from "../help";

describe("hasCommandHelp", () => {
	it("knows registered commands", () => {
		expect(hasCommandHelp("task")).toBe(true);
		expect(hasCommandHelp("note")).toBe(true);
		expect(hasCommandHelp("vents")).toBe(true);
	});

	it("does not claim unknown commands", () => {
		expect(hasCommandHelp("bogus")).toBe(false);
		// remote/gui render their own help inside their handlers and are
		// intentionally absent from the registry.
		expect(hasCommandHelp("remote")).toBe(false);
		expect(hasCommandHelp("gui")).toBe(false);
	});
});

describe("renderHelp — unknown command", () => {
	it("returns null", () => {
		expect(renderHelp("bogus")).toBeNull();
		expect(renderHelp("bogus", "sub")).toBeNull();
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
	});

	it("falls back to the group listing for an unknown subcommand", () => {
		const out = renderHelp("task", "frobnicate")!;
		expect(out).toContain("dev3 task — Inspect and manage individual tasks.");
		expect(out).toContain("Subcommands:");
	});
});

describe("renderHelp — subcommand detail", () => {
	it("renders the targeted subcommand's usage and details", () => {
		const out = renderHelp("task", "create")!;
		expect(out).toContain("dev3 task create — Create a new task in the To Do column.");
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
});

describe("renderHelp — leaf command", () => {
	it("renders usage/details directly for a leaf command", () => {
		const out = renderHelp("vents")!;
		expect(out).toContain("dev3 vents — File anonymous dev3-platform feedback");
		expect(out).toContain("Usage:");
		expect(out).toContain('dev3 vents "short name" "markdown body"');
		// A leaf command has no subcommand listing.
		expect(out).not.toContain("Subcommands:");
	});

	it("ignores a stray subcommand arg for a leaf command", () => {
		expect(renderHelp("vents", "whatever")).toEqual(renderHelp("vents"));
	});
});

describe("resolveHelp — routing decision", () => {
	it("no args → top-level help", () => {
		expect(resolveHelp([])).toEqual({ action: "top" });
	});

	it("bare --help → top-level help", () => {
		expect(resolveHelp(["--help"])).toEqual({ action: "top" });
		expect(resolveHelp(["-h"])).toEqual({ action: "top" });
	});

	it("'<command> --help' → command-specific help text", () => {
		const res = resolveHelp(["task", "--help"]);
		expect(res.action).toBe("command");
		if (res.action === "command") {
			expect(res.text).toBe(renderHelp("task"));
		}
	});

	it("'<command> <subcommand> --help' → subcommand-specific help text", () => {
		const res = resolveHelp(["task", "create", "--help"]);
		expect(res.action).toBe("command");
		if (res.action === "command") {
			expect(res.text).toBe(renderHelp("task", "create"));
		}
	});

	it("remote/gui --help fall through to their own handlers (none)", () => {
		expect(resolveHelp(["remote", "--help"])).toEqual({ action: "none" });
		expect(resolveHelp(["gui", "--help"])).toEqual({ action: "none" });
	});

	it("unknown '<command> --help' → top-level help", () => {
		expect(resolveHelp(["bogus", "--help"])).toEqual({ action: "top" });
	});

	it("a real invocation without --help is not a help request (none)", () => {
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
		"tasks",
		"task",
		"note",
		"vents",
		"overview",
		"label",
		"config",
		"dev-server",
	];

	for (const cmd of dispatched) {
		it(`has help for "${cmd}"`, () => {
			expect(hasCommandHelp(cmd)).toBe(true);
			expect(renderHelp(cmd)).not.toBeNull();
		});
	}

	it("every subcommand renders a non-empty detail view", () => {
		for (const cmd of dispatched) {
			const spec = getCommandHelp(cmd)!;
			for (const sub of spec.subcommands) {
				const out = renderHelp(cmd, sub.name)!;
				expect(out).toContain(`dev3 ${cmd} ${sub.name} —`);
				expect(out).toContain(sub.usage);
			}
		}
	});
});
