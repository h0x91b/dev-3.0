import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { availableCommands } from "../available";
import { BUILTIN_COMMANDS_PLUGIN } from "../builtins";
import { getCommandsRegistry, type CommandContext } from "../registry";
import { applyBuiltinPlugins } from "../../plugins/runtime";
import { setAgentTrafficEnabledForTests } from "../../agent-traffic-flag";
import { setHiddenControlsForTests } from "../../hidden-controls";

const ROUTES: CommandContext[] = [
	{ hasProject: false, hasTask: false },
	{ hasProject: true, hasTask: false },
	{ hasProject: true, hasTask: true },
];
const PROJECT_KINDS: Partial<CommandContext>[] = [{}, { isVirtual: true }, { gitless: true }];
const BOARD_VIEWS = [{ id: "builtin:kanban", name: "Kanban" }, { id: "acme:gantt", name: "Gantt" }];

function rows(ctx: CommandContext): string[] {
	const registered = getCommandsRegistry().list().map((entry) => entry.def);
	return availableCommands(registered, ctx).map((c) => `${c.category} ${c.labelKey}${c.labelVars ? ` ${JSON.stringify(c.labelVars)}` : ""}`);
}

// Recorded from the static list this slot replaced: same rows, same order, for every flag combination.
describe("command palette parity", () => {
	beforeAll(() => applyBuiltinPlugins([], [BUILTIN_COMMANDS_PLUGIN]));
	afterEach(() => {
		setAgentTrafficEnabledForTests(false);
		setHiddenControlsForTests([]);
	});

	it("lists the same commands for every context-flag combination", () => {
		const out: Record<string, string[]> = {};
		for (const traffic of [false, true]) {
			setAgentTrafficEnabledForTests(traffic);
			for (const route of ROUTES) {
				for (const kind of PROJECT_KINDS) {
					for (const remote of [false, true]) {
						const ctx = { ...route, ...kind, remote, boardViews: BOARD_VIEWS };
						out[JSON.stringify({ traffic, ...ctx, boardViews: undefined })] = rows(ctx);
					}
				}
			}
		}
		setAgentTrafficEnabledForTests(true);
		setHiddenControlsForTests(["stats-nav", "agent-traffic"]);
		out["hidden stats-nav + agent-traffic"] = rows({ hasProject: true, hasTask: true });
		expect(out).toMatchSnapshot();
	});
});
