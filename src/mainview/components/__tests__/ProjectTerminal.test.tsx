import { useEffect } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProjectTerminal from "../ProjectTerminal";
import { I18nProvider } from "../../i18n";

vi.mock("../../rpc", () => ({
	isElectrobun: false,
	api: {
		request: {
			getProjectPtyUrl: vi.fn().mockResolvedValue("ws://localhost:1234"),
			destroyProjectTerminal: vi.fn().mockResolvedValue(undefined),
		},
	},
}));

// onReady hands the host a TerminalHandle; without it termHandle stays null and
// the touch input stack can never mount, whatever the gate says.
vi.mock("../../TerminalView", () => ({
	default: ({ onReady }: { onReady?: (handle: unknown) => void }) => {
		// In an effect, not during render — the host setState would land outside act().
		useEffect(() => {
			onReady?.({ focus: vi.fn(), blur: vi.fn(), paste: vi.fn(), scrollToBottom: vi.fn(), write: vi.fn() });
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

function renderTerminal(onBack = vi.fn()) {
	return {
		onBack,
		...render(
			<I18nProvider>
				<ProjectTerminal
					projectId="p1"
					projectPath="/home/user/project"
					onBack={onBack}
				/>
			</I18nProvider>,
		),
	};
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
