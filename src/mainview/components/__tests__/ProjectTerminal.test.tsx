import { useEffect } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProjectTerminal from "../ProjectTerminal";
import { I18nProvider } from "../../i18n";
import { requestTerminalPaste } from "../../terminal-paste-request";
import { _resetFileExplorerPrefs, getFileExplorerPrefs, setFileExplorerMode, toggleFileExplorer } from "../../file-explorer-prefs";

const { lastHandle } = vi.hoisted(() => ({ lastHandle: { current: null as null | { paste: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> } } }));

vi.mock("../../rpc", () => ({
	isElectrobun: false,
	api: {
		request: {
			getProjectPtyUrl: vi.fn().mockResolvedValue("ws://localhost:1234"),
			destroyProjectTerminal: vi.fn().mockResolvedValue(undefined),
			listExplorerDirectory: vi.fn().mockResolvedValue({ root: "/home/user/project", relPath: "", entries: [] }),
		},
	},
}));

// onReady hands the host a TerminalHandle; without it termHandle stays null and
// the touch input stack can never mount, whatever the gate says.
vi.mock("../../TerminalView", () => ({
	default: ({ onReady }: { onReady?: (handle: unknown) => void }) => {
		// In an effect, not during render — the host setState would land outside act().
		useEffect(() => {
			const handle = { focus: vi.fn(), blur: vi.fn(), paste: vi.fn(), scrollToBottom: vi.fn(), write: vi.fn() };
			lastHandle.current = handle;
			onReady?.(handle);
		}, [onReady]);
		return <div data-testid="terminal-view" />;
	},
}));

vi.mock("../ExtraKeyBar", () => ({
	default: () => <div data-testid="extra-key-bar" />,
}));

const originalMaxTouchPoints = Object.getOwnPropertyDescriptor(Navigator.prototype, "maxTouchPoints");
const originalMatchMedia = window.matchMedia;

function setTouchPoints(maxTouchPoints: number) {
	Object.defineProperty(navigator, "maxTouchPoints", { value: maxTouchPoints, configurable: true });
}

function setCoarsePointer(coarse: boolean) {
	window.matchMedia = ((query: string) => ({
		matches: query.includes("pointer: coarse") ? coarse : query.includes("prefers-reduced-motion"),
		media: query,
		onchange: null,
		addEventListener: () => {},
		removeEventListener: () => {},
		addListener: () => {},
		removeListener: () => {},
		dispatchEvent: () => false,
	})) as typeof window.matchMedia;
}

function terminalTree(projectId: string, onBack = vi.fn()) {
	return (
		<I18nProvider>
			<ProjectTerminal
				projectId={projectId}
				projectPath="/home/user/project"
				projectName="project"
				onBack={onBack}
			/>
		</I18nProvider>
	);
}

function renderTerminal(onBack = vi.fn()) {
	return { onBack, ...render(terminalTree("p1", onBack)) };
}

function savedExplorerMode() {
	return JSON.parse(localStorage.getItem("dev3-file-explorer") ?? "{}").mode;
}

describe("ProjectTerminal — back-to-board toolbar", () => {
	it("renders the back-to-board button", async () => {
		renderTerminal();
		expect(screen.getByText("Back to Board")).toBeInTheDocument();
	});

	it("renders the project path", async () => {
		renderTerminal();
		expect(screen.getByText("/home/user/project")).toBeInTheDocument();
	});

	it("renders the shortcut hint", async () => {
		renderTerminal();
		expect(screen.getByText("\u2318`")).toBeInTheDocument();
	});

	it("calls onBack when clicking the back button", async () => {
		const user = userEvent.setup();
		const { onBack } = renderTerminal();
		await user.click(screen.getByText("Back to Board"));
		expect(onBack).toHaveBeenCalledTimes(1);
	});
});

// Mirrors the TaskTerminal gate: both call sites share isTouchPrimary().
describe("ProjectTerminal — touch input gate", () => {
	afterEach(() => {
		if (originalMaxTouchPoints) {
			Object.defineProperty(Navigator.prototype, "maxTouchPoints", originalMaxTouchPoints);
		} else {
			setTouchPoints(0);
		}
		window.matchMedia = originalMatchMedia;
	});

	it("mounts the key bar on a phone", async () => {
		setTouchPoints(5);
		setCoarsePointer(true);
		renderTerminal();
		expect(await screen.findByTestId("extra-key-bar")).toBeInTheDocument();
	});

	it("stays hidden on a touchscreen laptop, whose primary pointer is the mouse", async () => {
		setTouchPoints(10);
		setCoarsePointer(false);
		renderTerminal();
		await screen.findByTestId("terminal-view");
		expect(screen.queryByTestId("extra-key-bar")).not.toBeInTheDocument();
	});
});

describe("ProjectTerminal — Repo explorer", () => {
	afterEach(() => {
		localStorage.removeItem("dev3-file-explorer");
		_resetFileExplorerPrefs();
	});

	it("lays the project explorer beside the terminal", async () => {
		setFileExplorerMode("pinned");
		renderTerminal();
		expect(await screen.findByTestId("file-explorer")).toBeInTheDocument();
		expect(screen.getByTestId("terminal-view")).toBeInTheDocument();
	});

	it("types an inserted path into the project terminal", async () => {
		renderTerminal();
		await screen.findByTestId("terminal-view");
		await waitFor(() => expect(lastHandle.current).not.toBeNull());
		// Let the host commit the handle it was given, so its paste subscription sees it.
		await act(async () => {});
		act(() => requestTerminalPaste("project-p1", "src/a.ts "));
		expect(lastHandle.current?.paste).toHaveBeenCalledWith("src/a.ts ");
		expect(lastHandle.current?.focus).toHaveBeenCalled();
		act(() => requestTerminalPaste("task-1", "other.ts "));
		expect(lastHandle.current?.paste).toHaveBeenCalledTimes(1);
	});

	it("opens a hidden explorer on entry without saving it for task terminals", async () => {
		setFileExplorerMode("hidden");
		const { unmount } = renderTerminal();
		expect(await screen.findByTestId("file-explorer-pinned")).toBeInTheDocument();
		expect(savedExplorerMode()).toBe("hidden");
		unmount();
		expect(getFileExplorerPrefs().mode).toBe("hidden");
	});

	it("stays closed for the rest of the visit and reopens on the next entry", async () => {
		setFileExplorerMode("hidden");
		const user = userEvent.setup();
		const { unmount } = renderTerminal();
		await screen.findByTestId("file-explorer-pinned");
		await user.click(screen.getByRole("button", { name: "More actions" }));
		await user.click(await screen.findByRole("menuitem", { name: "Hide explorer" }));
		expect(screen.queryByTestId("file-explorer")).not.toBeInTheDocument();
		await act(async () => {});
		expect(screen.queryByTestId("file-explorer")).not.toBeInTheDocument();
		unmount();
		renderTerminal();
		expect(await screen.findByTestId("file-explorer-pinned")).toBeInTheDocument();
	});

	it("lets the toggle close an explorer the visit opened", async () => {
		setFileExplorerMode("hidden");
		renderTerminal();
		await screen.findByTestId("file-explorer-pinned");
		act(() => toggleFileExplorer());
		expect(screen.queryByTestId("file-explorer")).not.toBeInTheDocument();
	});

	it("reopens the explorer when the Repo screen switches project", async () => {
		setFileExplorerMode("hidden");
		const { rerender } = renderTerminal();
		await screen.findByTestId("file-explorer-pinned");
		act(() => setFileExplorerMode("hidden"));
		expect(screen.queryByTestId("file-explorer")).not.toBeInTheDocument();
		rerender(terminalTree("p2"));
		expect(await screen.findByTestId("file-explorer-pinned")).toBeInTheDocument();
	});

	it("slides an auto-hidden tree in on entry without taking focus", async () => {
		setFileExplorerMode("autohide");
		renderTerminal();
		const overlay = await screen.findByTestId("file-explorer-overlay");
		expect(overlay).toContainElement(screen.getByTestId("file-explorer"));
		expect(overlay.contains(document.activeElement)).toBe(false);
	});
});
