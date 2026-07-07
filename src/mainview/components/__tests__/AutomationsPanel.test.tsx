import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Automation, Project } from "../../../shared/types";
import { I18nProvider } from "../../i18n";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			listAutomations: vi.fn(),
			createAutomation: vi.fn(),
			updateAutomation: vi.fn(),
			deleteAutomation: vi.fn(),
			runAutomationNow: vi.fn(),
			getAgents: vi.fn(() => Promise.resolve([])),
		},
	},
	isElectrobun: true,
}));

vi.mock("../../confirm", () => ({
	confirm: vi.fn(() => Promise.resolve(true)),
}));

import { api } from "../../rpc";
import { confirm } from "../../confirm";
import AutomationsPanel from "../AutomationsPanel";

const project: Project = {
	id: "proj-1",
	name: "Test",
	path: "/tmp/test",
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	defaultBaseBranch: "main",
	createdAt: "2026-01-01T00:00:00Z",
};

const automation: Automation = {
	id: "auto-1111-2222",
	projectId: "proj-1",
	name: "Weekly report",
	prompt: "Write the report.",
	rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0",
	timezone: "UTC",
	agentId: null,
	configId: null,
	enabled: true,
	catchUp: "skip",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
	nextRunAt: "2026-07-10T17:00:00.000Z",
	runs: [
		{ id: "run-1", scheduledFor: "2026-07-03T17:00:00.000Z", firedAt: "2026-07-03T17:00:10.000Z", status: "created", taskId: "task-123456789" },
	],
};

function renderPanel() {
	return render(
		<I18nProvider>
			<AutomationsPanel project={project} />
		</I18nProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("AutomationsPanel", () => {
	it("shows the empty state when there are no automations", async () => {
		vi.mocked(api.request.listAutomations).mockResolvedValue([]);
		renderPanel();
		expect(await screen.findByText("No automations yet.")).toBeTruthy();
	});

	it("renders an automation row with schedule and next run", async () => {
		vi.mocked(api.request.listAutomations).mockResolvedValue([automation]);
		renderPanel();
		expect(await screen.findByText("Weekly report")).toBeTruthy();
		expect(screen.getByText(/FREQ=WEEKLY;BYDAY=FR/)).toBeTruthy();
		expect(screen.getByText(/Next run:/)).toBeTruthy();
	});

	it("opens the create modal from the New automation button", async () => {
		vi.mocked(api.request.listAutomations).mockResolvedValue([]);
		renderPanel();
		await screen.findByText("No automations yet.");
		await userEvent.click(screen.getByText("New automation"));
		expect(await screen.findByRole("dialog")).toBeTruthy();
		expect(screen.getByText("New automation", { selector: "h2" })).toBeTruthy();
	});

	it("portals the modal to <body> so it escapes ancestor containing blocks (#845)", async () => {
		// The modal is rendered deep inside ProjectSettings' `backdrop-blur` card.
		// `backdrop-filter` establishes a containing block for `position: fixed`
		// descendants, so an inline `fixed inset-0` modal anchors to that ~672px
		// card instead of the viewport and lands partially off-screen. Portaling to
		// document.body detaches it from the panel subtree and re-anchors to the viewport.
		vi.mocked(api.request.listAutomations).mockResolvedValue([]);
		const { container } = renderPanel();
		await screen.findByText("No automations yet.");
		await userEvent.click(screen.getByText("New automation"));
		const dialog = await screen.findByRole("dialog");
		expect(container.contains(dialog)).toBe(false);
		expect(document.body.contains(dialog)).toBe(true);
	});

	it("fires runAutomationNow from the Run now button", async () => {
		vi.mocked(api.request.listAutomations).mockResolvedValue([automation]);
		vi.mocked(api.request.runAutomationNow).mockResolvedValue({ taskId: "task-1" });
		renderPanel();
		await screen.findByText("Weekly report");
		await userEvent.click(screen.getByText("Run now"));
		await waitFor(() => {
			expect(api.request.runAutomationNow).toHaveBeenCalledWith({ projectId: "proj-1", automationId: automation.id });
		});
	});

	it("toggles enabled via the switch", async () => {
		vi.mocked(api.request.listAutomations).mockResolvedValue([automation]);
		vi.mocked(api.request.updateAutomation).mockResolvedValue({ ...automation, enabled: false });
		renderPanel();
		await screen.findByText("Weekly report");
		await userEvent.click(screen.getByRole("switch"));
		await waitFor(() => {
			expect(api.request.updateAutomation).toHaveBeenCalledWith({
				projectId: "proj-1",
				automationId: automation.id,
				enabled: false,
			});
		});
	});

	it("deletes after confirmation", async () => {
		vi.mocked(api.request.listAutomations).mockResolvedValue([automation]);
		vi.mocked(api.request.deleteAutomation).mockResolvedValue(undefined);
		renderPanel();
		await screen.findByText("Weekly report");
		await userEvent.click(screen.getByText("Delete"));
		await waitFor(() => {
			expect(confirm).toHaveBeenCalled();
			expect(api.request.deleteAutomation).toHaveBeenCalledWith({ projectId: "proj-1", automationId: automation.id });
		});
	});

	it("does not delete when confirmation is declined", async () => {
		vi.mocked(confirm).mockResolvedValueOnce(false);
		vi.mocked(api.request.listAutomations).mockResolvedValue([automation]);
		renderPanel();
		await screen.findByText("Weekly report");
		await userEvent.click(screen.getByText("Delete"));
		await waitFor(() => expect(confirm).toHaveBeenCalled());
		expect(api.request.deleteAutomation).not.toHaveBeenCalled();
	});

	it("expands the run history on click", async () => {
		vi.mocked(api.request.listAutomations).mockResolvedValue([automation]);
		renderPanel();
		await screen.findByText("Weekly report");
		await userEvent.click(screen.getByText(/Last run/));
		expect(await screen.findByText("ok")).toBeTruthy();
		expect(screen.getByText(/task-123/)).toBeTruthy();
	});

	it("reloads when rpc:automationsUpdated fires for this project", async () => {
		vi.mocked(api.request.listAutomations).mockResolvedValue([]);
		renderPanel();
		await screen.findByText("No automations yet.");
		vi.mocked(api.request.listAutomations).mockResolvedValue([automation]);
		window.dispatchEvent(new CustomEvent("rpc:automationsUpdated", { detail: { projectId: "proj-1" } }));
		expect(await screen.findByText("Weekly report")).toBeTruthy();
	});
});
