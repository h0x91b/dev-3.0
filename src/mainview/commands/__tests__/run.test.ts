import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_COMMANDS_PLUGIN } from "../builtins";
import { getCommandsRegistry } from "../registry";
import { applyBuiltinPlugins } from "../../plugins/runtime";
import { OPEN_AGENT_TRAFFIC_LOG_EVENT } from "../../agent-traffic-events";
import { getFileExplorerPrefs, setFileExplorerMode } from "../../file-explorer-prefs";
import type { AppActionContext } from "../../app-actions";
import type { AppState } from "../../state";

const { request, moveTaskToStatus } = vi.hoisted(() => ({
	request: {
		setTmuxTheme: vi.fn(() => Promise.resolve()),
		pullProjectMain: vi.fn(() => Promise.resolve()),
		createPullRequest: vi.fn(() => Promise.resolve()),
		runDevServer: vi.fn(() => Promise.resolve()),
		stopDevServer: vi.fn(() => Promise.resolve()),
		getDevServerStatus: vi.fn(() => Promise.resolve({ running: true })),
		toggleTaskWatch: vi.fn(() => Promise.resolve()),
		openFolder: vi.fn(() => Promise.resolve()),
	},
	moveTaskToStatus: vi.fn((_opts: unknown) => Promise.resolve(true)),
}));
vi.mock("../../rpc", () => ({ api: { request } }));
vi.mock("../../utils/moveTaskToStatus", () => ({ moveTaskToStatus }));

const TASK = { id: "t1", projectId: "p1", worktreePath: "/wt/t1", watched: false };
const PROJECT = { id: "p1", kind: "git" };

function taskCtx(): AppActionContext {
	return {
		state: {
			route: { screen: "task", projectId: "p1", taskId: "t1" },
			projects: [PROJECT],
			currentProjectTasks: [TASK],
		} as unknown as AppState,
		dispatch: vi.fn(),
		setLocale: vi.fn(),
		t: ((key: string) => key) as never,
	};
}

type Effect =
	| { event: string; detail?: unknown }
	| { dispatch: unknown }
	| { locale: string }
	| { rpc: keyof typeof request; args: unknown[] }
	| { move: string; alwaysConfirm?: boolean }
	| { check: () => void };

const nav = (route: unknown): Effect => ({ dispatch: { type: "navigate", route } });
const target = { taskId: "t1", projectId: "p1" };

/** What each palette command did when it was a menuRouter action, run on a task screen. */
const EXPECTED: Record<string, Effect[]> = {
	"open-new-task": [{ event: "menu:open-new-task" }],
	"open-add-project": [{ event: "menu:open-add-project" }],
	"project-import-conversations": [{ event: "menu:import-conversations", detail: { projectId: "p1" } }],
	"help-explain-screen": [{ event: "menu:enter-help-mode" }],
	"view-dashboard": [nav({ screen: "dashboard" })],
	"view-board": [nav({ screen: "project", projectId: "p1" })],
	"find-coordinator": [{ event: "menu:open-coordinator-finder" }],
	"open-task-switch": [{ event: "menu:open-task-switch" }],
	"open-combined-switch": [{ event: "menu:open-combined-switch" }],
	"view-changelog": [nav({ screen: "changelog" })],
	"view-stats": [nav({ screen: "stats" })],
	"view-sessions": [nav({ screen: "sessions", scopeProjectId: "p1" })],
	"view-library": [nav({ screen: "library", scopeProjectId: "p1" })],
	"open-settings": [nav({ screen: "settings" })],
	"project-settings": [nav({ screen: "project-settings", projectId: "p1" })],
	"go-back": [{ dispatch: { type: "goBack" } }],
	"go-forward": [{ dispatch: { type: "goForward" } }],
	"set-theme-light": [{ rpc: "setTmuxTheme", args: [{ theme: "light", preference: "light" }] }],
	"set-theme-dark": [{ rpc: "setTmuxTheme", args: [{ theme: "dark", preference: "dark" }] }],
	"set-theme-auto": [{ check: () => expect(localStorage.getItem("dev3-theme")).toBe("system") }],
	"set-locale-en": [{ locale: "en" }],
	"set-locale-ru": [{ locale: "ru" }],
	"set-locale-es": [{ locale: "es" }],
	"toggle-streamer-mode": [{ check: () => expect(localStorage.getItem("dev3-streamer-mode")).toBe("on") }],
	"project-pull-main": [{ rpc: "pullProjectMain", args: [{ projectId: "p1" }] }],
	"project-create-pr": [{ rpc: "createPullRequest", args: [target] }],
	"project-dev-server-start": [{ rpc: "runDevServer", args: [{ ...target, focus: true }] }],
	"project-dev-server-stop": [{ rpc: "stopDevServer", args: [target] }],
	"project-dev-server-restart": [
		{ rpc: "stopDevServer", args: [target] },
		{ rpc: "runDevServer", args: [{ ...target, focus: true }] },
	],
	"project-dev-server-status": [{ event: "menu:dev-server-status", detail: { running: true } }],
	"task-toggle-watch": [{ rpc: "toggleTaskWatch", args: [{ ...target, watched: true }] }],
	"task-open-in-finder": [{ rpc: "openFolder", args: [{ path: "/wt/t1" }] }],
	"task-copy-worktree-path": [{ check: () => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("/wt/t1") }],
	"task-run-script": [{ event: "menu:task-run-script", detail: { taskId: "t1" } }],
	"task-move-todo": [{ move: "todo" }],
	"task-move-in-progress": [{ move: "in-progress" }],
	"task-move-user-questions": [{ move: "user-questions" }],
	"task-move-review-ai": [{ move: "review-by-ai" }],
	"task-move-review-user": [{ move: "review-by-user" }],
	"term-toggle-project-terminal": [nav({ screen: "project-terminal", projectId: "p1" })],
	"term-open-quick-shell": [{ event: "menu:open-quick-shell" }],
	"term-cheat-sheet": [{ event: "menu:show-tmux-cheat-sheet" }],
	"help-keyboard-shortcuts": [{ event: "menu:show-keyboard-shortcuts" }],
	"view-agent-traffic-log": [{ event: OPEN_AGENT_TRAFFIC_LOG_EVENT, detail: { scope: "current-project", focus: undefined } }],
	// Pinned before each run, so the toggle on a task screen hides it.
	"view-toggle-file-explorer": [{ check: () => expect(getFileExplorerPrefs().mode).toBe("hidden") }],
};

const registered = () => getCommandsRegistry().list().map((entry) => entry.def);

describe("built-in palette commands", () => {
	beforeAll(() => {
		applyBuiltinPlugins([], [BUILTIN_COMMANDS_PLUGIN]);
		Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(() => Promise.resolve()) }, configurable: true });
	});
	beforeEach(() => setFileExplorerMode("pinned"));
	afterEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		delete document.documentElement.dataset.streamer;
	});

	it("has an expected effect for every registered command", () => {
		expect(registered().map((c) => c.id.replace(/^builtin:/, "")).sort()).toEqual(Object.keys(EXPECTED).sort());
	});

	it.each(Object.entries(EXPECTED))("%s runs as it did through the menu router", async (name, effects) => {
		const command = getCommandsRegistry().get(`builtin:${name}`)?.def;
		expect(command).toBeDefined();
		const ctx = taskCtx();
		const events: CustomEvent[] = [];
		const listen = (e: Event) => events.push(e as CustomEvent);
		const eventNames = effects.flatMap((effect) => ("event" in effect ? [effect.event] : []));
		for (const n of eventNames) window.addEventListener(n, listen);
		try {
			await command!.run(ctx);
		} finally {
			for (const n of eventNames) window.removeEventListener(n, listen);
		}
		for (const effect of effects) {
			if ("event" in effect) {
				const hit = events.find((e) => e.type === effect.event);
				expect(hit, effect.event).toBeDefined();
				if ("detail" in effect) expect(hit!.detail).toEqual(effect.detail);
			} else if ("dispatch" in effect) {
				expect(ctx.dispatch).toHaveBeenCalledWith(effect.dispatch);
			} else if ("locale" in effect) {
				expect(ctx.setLocale).toHaveBeenCalledWith(effect.locale);
			} else if ("rpc" in effect) {
				expect(request[effect.rpc]).toHaveBeenCalledWith(...effect.args);
			} else if ("move" in effect) {
				expect(moveTaskToStatus).toHaveBeenCalledWith(expect.objectContaining({ task: TASK, project: PROJECT, newStatus: effect.move }));
				expect(moveTaskToStatus.mock.calls[0][0]).not.toHaveProperty("alwaysConfirm");
			} else {
				effect.check();
			}
		}
	});
});
