import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { I18nProvider } from "../i18n";

vi.mock("../rpc", () => ({
	api: {
		request: {
			checkSystemRequirements: vi.fn().mockResolvedValue([]),
			getProjects: vi.fn().mockResolvedValue([]),
			quitApp: vi.fn().mockResolvedValue(undefined),
			hideApp: vi.fn().mockResolvedValue(undefined),
			listTmuxSessions: vi.fn().mockResolvedValue([]),
		},
	},
}));

vi.mock("../analytics", () => ({
	trackPageView: vi.fn(),
	trackEvent: vi.fn(),
}));

vi.mock("../zoom", () => ({
	adjustZoom: vi.fn(),
	applyZoom: vi.fn(),
	ZOOM_STEP: 0.1,
	DEFAULT_ZOOM: 1.0,
	getZoom: vi.fn().mockReturnValue(1.0),
	bootstrapZoom: vi.fn(),
	ZOOM_CHANGED_EVENT: "zoom-changed",
	MIN_ZOOM: 0.5,
	MAX_ZOOM: 2.0,
}));

// Mock child screens so they don't trigger their own API calls
vi.mock("../components/Dashboard", () => ({
	default: () => <div data-testid="dashboard-screen" />,
}));
vi.mock("../components/GlobalSettings", () => ({
	default: () => <div data-testid="settings-screen" />,
}));
vi.mock("../components/Changelog", () => ({
	default: (_props: { navigate: unknown; previousRoute: unknown }) => <div data-testid="changelog-screen" />,
}));
vi.mock("../components/ProjectView", () => ({
	default: () => <div data-testid="project-screen" />,
}));
vi.mock("../components/TaskTerminal", () => ({
	default: () => <div data-testid="task-screen" />,
}));
vi.mock("../components/ProjectSettings", () => ({
	default: () => <div data-testid="project-settings-screen" />,
}));
vi.mock("../components/RequirementsCheck", () => ({
	default: () => <div data-testid="requirements-check" />,
}));
vi.mock("../components/gauges/GaugeDemo", () => ({
	default: () => <div data-testid="gauge-demo-screen" />,
}));

import { api } from "../rpc";
import { adjustZoom, applyZoom, ZOOM_STEP, DEFAULT_ZOOM } from "../zoom";

const mockedAdjustZoom = vi.mocked(adjustZoom);
const mockedApplyZoom = vi.mocked(applyZoom);

async function renderApp() {
	render(
		<I18nProvider>
			<App />
		</I18nProvider>,
	);
	await waitFor(() =>
		expect(screen.getByTestId("dashboard-screen")).toBeInTheDocument(),
	);
}

describe("App keyboard shortcuts", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(api.request.checkSystemRequirements).mockResolvedValue([]);
		vi.mocked(api.request.getProjects).mockResolvedValue([]);
		vi.mocked(api.request.listTmuxSessions).mockResolvedValue([]);
	});

	describe("quit (Cmd+Q / Ctrl+Q)", () => {
		it("Cmd+Q opens the quit dialog", async () => {
			await renderApp();
			await userEvent.keyboard("{Meta>}q{/Meta}");
			expect(screen.getByText("Sessions keep running")).toBeInTheDocument();
		});

		it("Ctrl+Q opens the quit dialog", async () => {
			await renderApp();
			await userEvent.keyboard("{Control>}q{/Control}");
			expect(screen.getByText("Sessions keep running")).toBeInTheDocument();
		});

		it("Escape closes the quit dialog", async () => {
			await renderApp();
			await userEvent.keyboard("{Meta>}q{/Meta}");
			expect(screen.getByText("Sessions keep running")).toBeInTheDocument();
			await userEvent.keyboard("{Escape}");
			expect(screen.queryByText("Sessions keep running")).not.toBeInTheDocument();
		});

		it("Quit button in dialog calls quitApp", async () => {
			vi.mocked(api.request.quitApp).mockResolvedValue(undefined);
			await renderApp();
			await userEvent.keyboard("{Meta>}q{/Meta}");
			await userEvent.click(screen.getByRole("button", { name: "Quit" }));
			expect(api.request.quitApp).toHaveBeenCalled();
		});
	});

	describe("hide (Cmd+H / Ctrl+H)", () => {
		it("Cmd+H calls hideApp", async () => {
			await renderApp();
			await userEvent.keyboard("{Meta>}h{/Meta}");
			expect(api.request.hideApp).toHaveBeenCalled();
		});

		it("Ctrl+H calls hideApp", async () => {
			await renderApp();
			await userEvent.keyboard("{Control>}h{/Control}");
			expect(api.request.hideApp).toHaveBeenCalled();
		});
	});

	describe("settings (Cmd+, / Ctrl+,)", () => {
		it("Cmd+, navigates to the settings screen", async () => {
			await renderApp();
			await userEvent.keyboard("{Meta>},{/Meta}");
			expect(screen.getByTestId("settings-screen")).toBeInTheDocument();
		});

		it("Ctrl+, navigates to the settings screen", async () => {
			await renderApp();
			await userEvent.keyboard("{Control>},{/Control}");
			expect(screen.getByTestId("settings-screen")).toBeInTheDocument();
		});

		it("Escape from settings goes back to dashboard", async () => {
			await renderApp();
			await userEvent.keyboard("{Meta>},{/Meta}");
			expect(screen.getByTestId("settings-screen")).toBeInTheDocument();
			await userEvent.keyboard("{Escape}");
			expect(screen.getByTestId("dashboard-screen")).toBeInTheDocument();
		});
	});

	describe("zoom (Cmd/Ctrl + = - 0)", () => {
		it("Cmd+= calls adjustZoom with +ZOOM_STEP", async () => {
			await renderApp();
			await userEvent.keyboard("{Meta>}={/Meta}");
			expect(mockedAdjustZoom).toHaveBeenCalledWith(ZOOM_STEP);
		});

		it("Ctrl+= calls adjustZoom with +ZOOM_STEP", async () => {
			await renderApp();
			await userEvent.keyboard("{Control>}={/Control}");
			expect(mockedAdjustZoom).toHaveBeenCalledWith(ZOOM_STEP);
		});

		it("Cmd+- calls adjustZoom with -ZOOM_STEP", async () => {
			await renderApp();
			await userEvent.keyboard("{Meta>}-{/Meta}");
			expect(mockedAdjustZoom).toHaveBeenCalledWith(-ZOOM_STEP);
		});

		it("Ctrl+- calls adjustZoom with -ZOOM_STEP", async () => {
			await renderApp();
			await userEvent.keyboard("{Control>}-{/Control}");
			expect(mockedAdjustZoom).toHaveBeenCalledWith(-ZOOM_STEP);
		});

		it("Cmd+0 calls applyZoom with DEFAULT_ZOOM", async () => {
			await renderApp();
			await userEvent.keyboard("{Meta>}0{/Meta}");
			expect(mockedApplyZoom).toHaveBeenCalledWith(DEFAULT_ZOOM);
		});

		it("Ctrl+0 calls applyZoom with DEFAULT_ZOOM", async () => {
			await renderApp();
			await userEvent.keyboard("{Control>}0{/Control}");
			expect(mockedApplyZoom).toHaveBeenCalledWith(DEFAULT_ZOOM);
		});
	});
});
