import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { Context } from "cordis";
import { useEffect } from "react";
import { _resetFileExplorerPrefs, getFileExplorerPrefs, setFileExplorerMode } from "../../file-explorer-prefs";
import { I18nProvider } from "../../i18n";
import { getAppRoot } from "../../plugins/root";
import { applyBuiltinPlugins, resetPluginsForTests } from "../../plugins/runtime";
import { BUILTIN_TERMINAL_COMPANION_PLUGIN, FILE_EXPLORER_COMPANION_ID } from "../builtins";
import { useTerminalCompanionProps } from "../props";
import { getTerminalCompanionRegistry } from "../registry";
import { TerminalCompanion } from "../TerminalCompanion";

const explorer = vi.hoisted(() => ({ crash: false, mounts: 0 }));
const terminalMounts = vi.hoisted(() => ({ count: 0 }));
const tooltip = vi.hoisted(() => ({ throwsLeft: 0 }));

vi.mock("../../components/Tooltip", () => ({
	default: ({ children }: { children: React.ReactNode }) => {
		if (tooltip.throwsLeft > 0) {
			tooltip.throwsLeft--;
			throw new Error("frame boom");
		}
		return <>{children}</>;
	},
}));

vi.mock("../../rpc", () => ({ api: { request: {} } }));
vi.mock("../../components/FileExplorer", () => ({
	default: ({ taskId }: { taskId?: string | null }) => {
		if (explorer.crash) throw new Error("explorer boom");
		useEffect(() => {
			explorer.mounts++;
		}, []);
		return <div data-testid="explorer">{taskId}</div>;
	},
	ExplorerRailGlyph: () => null,
}));

function Terminal() {
	useEffect(() => {
		terminalMounts.count++;
	}, []);
	return <div data-testid="terminal" />;
}

async function settle(): Promise<void> {
	for (let tick = 0; tick < 50; tick++) await act(async () => {});
}

function Pane({ taskId }: { taskId: string }) {
	return (
		<I18nProvider>
			<TerminalCompanion projectId="p1" taskId={taskId} rootLabel="branch" enabled>
				<Terminal />
			</TerminalCompanion>
		</I18nProvider>
	);
}

beforeEach(() => {
	resetPluginsForTests();
	localStorage.clear();
	_resetFileExplorerPrefs();
	setFileExplorerMode("pinned");
	explorer.crash = false;
	explorer.mounts = 0;
	tooltip.throwsLeft = 0;
	terminalMounts.count = 0;
});

describe("terminal companion slot", () => {
	it("draws the built-in file explorer from the slot around the host's terminal", async () => {
		applyBuiltinPlugins([], [BUILTIN_TERMINAL_COMPANION_PLUGIN]);
		await settle();
		expect(getTerminalCompanionRegistry().list().map((entry) => entry.def.id)).toEqual([FILE_EXPLORER_COMPANION_ID]);
		render(<Pane taskId="t1" />);
		expect(within(screen.getByTestId("file-explorer-pinned")).getByTestId("explorer").textContent).toBe("t1");
		expect(screen.getByTestId("terminal")).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("keeps the terminal and the explorer mounted across the built-in's registration and a task switch", async () => {
		const { rerender } = render(<Pane taskId="t1" />);
		const terminal = screen.getByTestId("terminal");
		applyBuiltinPlugins([], [BUILTIN_TERMINAL_COMPANION_PLUGIN]);
		await settle();
		rerender(<Pane taskId="t2" />);
		expect(screen.getByTestId("terminal")).toBe(terminal);
		expect(screen.getByTestId("explorer").textContent).toBe("t2");
		expect(terminalMounts.count).toBe(1);
		expect(explorer.mounts).toBe(1);
	});

	it("shows a crashed explorer's notice inside its column, leaves the terminal alone and lets it be hidden", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		applyBuiltinPlugins([], [BUILTIN_TERMINAL_COMPANION_PLUGIN]);
		await settle();
		explorer.crash = true;
		const { rerender } = render(<Pane taskId="t1" />);
		const terminal = screen.getByTestId("terminal");
		const notice = within(screen.getByTestId("file-explorer-pinned")).getByTestId("file-explorer-crashed");
		expect(notice.textContent).toContain("The file explorer stopped working.");

		explorer.crash = false;
		rerender(<Pane taskId="t2" />);
		expect(screen.queryByTestId("file-explorer-crashed")).toBeNull();
		expect(screen.getByTestId("explorer").textContent).toBe("t2");

		explorer.crash = true;
		rerender(<Pane taskId="t3" />);
		fireEvent.click(within(screen.getByTestId("file-explorer-crashed")).getByRole("button", { name: "Hide explorer" }));
		expect(getFileExplorerPrefs().mode).toBe("hidden");
		expect(screen.getByTestId("terminal")).toBe(terminal);
		expect(terminalMounts.count).toBe(1);
		errors.mockRestore();
	});

	it("falls back from a crashing replacement to the built-in, noticed inside the explorer column until dismissed", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const Boom = () => {
			throw new Error("boom");
		};
		getAppRoot().plugin({
			name: "throwing-companion",
			inject: ["terminalCompanion"],
			apply(ctx: Context) {
				ctx.terminalCompanion.register({ id: FILE_EXPLORER_COMPANION_ID, component: Boom });
			},
		});
		await settle();
		render(<Pane taskId="t1" />);
		const column = screen.getByTestId("file-explorer-pinned");
		const terminal = screen.getByTestId("terminal");
		expect(within(column).getByTestId("explorer")).toBeTruthy();
		expect(within(column).getByRole("alert").textContent).toContain("This file explorer failed to load, so the built-in one is shown.");
		expect(terminal.closest("[data-testid=file-explorer-pinned]")).toBeNull();

		const mountsBeforeDismiss = explorer.mounts;
		fireEvent.click(within(column).getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByRole("alert")).toBeNull();
		expect(explorer.mounts).toBe(mountsBeforeDismiss);
		expect(screen.getByTestId("explorer")).toBeTruthy();
		expect(screen.getByTestId("terminal")).toBe(terminal);
		errors.mockRestore();
	});

	it("re-renders a crashed built-in frame without claiming a replacement failed", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		applyBuiltinPlugins([], [BUILTIN_TERMINAL_COMPANION_PLUGIN]);
		await settle();
		setFileExplorerMode("autohide");
		tooltip.throwsLeft = 3; // enough throws that React's own retries give up and the outer boundary takes it
		render(<Pane taskId="t1" />);
		fireEvent.click(within(screen.getByTestId("file-explorer-rail")).getByRole("button"));
		expect(within(screen.getByTestId("file-explorer-overlay")).getByTestId("explorer")).toBeTruthy();
		expect(screen.getByTestId("terminal")).toBeTruthy();
		expect(screen.queryByTestId("terminal-companion-crashed")).toBeNull();
		errors.mockRestore();
	});

	it("refuses a companion rendered outside any host", () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const Orphan = () => <div>{String(useTerminalCompanionProps())}</div>;
		expect(() => render(<Orphan />)).toThrow("terminal companion rendered outside any <TerminalCompanion>");
		errors.mockRestore();
	});
});
