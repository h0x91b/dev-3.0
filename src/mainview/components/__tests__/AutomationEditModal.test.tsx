import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Automation, Project } from "../../../shared/types";
import { I18nProvider } from "../../i18n";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			createAutomation: vi.fn(() => Promise.resolve()),
			updateAutomation: vi.fn(() => Promise.resolve()),
			getAgents: vi.fn(() => Promise.resolve([])),
		},
	},
	isElectrobun: true,
}));

import { api } from "../../rpc";
import AutomationEditModal from "../AutomationEditModal";

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

const weeklyAutomation: Automation = {
	id: "auto-1",
	projectId: "proj-1",
	name: "Friday report",
	prompt: "Write the report.",
	rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0",
	timezone: "UTC",
	agentId: null,
	configId: null,
	enabled: true,
	catchUp: "skip",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
	nextRunAt: null,
	runs: [],
};

function renderCreate() {
	return render(
		<I18nProvider>
			<AutomationEditModal project={project} automation={null} onClose={() => {}} onSaved={() => {}} />
		</I18nProvider>,
	);
}

async function fillNameAndPrompt(user: ReturnType<typeof userEvent.setup>) {
	await user.type(screen.getByLabelText("Name"), "My automation");
	await user.type(screen.getByLabelText(/Prompt/), "Do the thing.");
}

// The default timezone is the host machine's, so pin it for deterministic presets.
async function setTimezone(user: ReturnType<typeof userEvent.setup>, tz: string) {
	const input = screen.getByLabelText(/Timezone/);
	await user.clear(input);
	await user.type(input, tz);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("AutomationEditModal — daily day picker", () => {
	it("defaults to Daily with all days selected and saves FREQ=DAILY", async () => {
		const user = userEvent.setup();
		renderCreate();
		await fillNameAndPrompt(user);

		// All seven weekday chips start pressed (= every day).
		for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
			expect(screen.getByRole("button", { name: day }).getAttribute("aria-pressed")).toBe("true");
		}

		await user.click(screen.getByRole("button", { name: "Create" }));
		expect(api.request.createAutomation).toHaveBeenCalledWith(
			expect.objectContaining({ rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0" }),
		);
	});

	it("the Weekdays preset saves a Mon–Fri weekly rule (Western timezone)", async () => {
		const user = userEvent.setup();
		renderCreate();
		await fillNameAndPrompt(user);
		await setTimezone(user, "Europe/Berlin");

		await user.click(screen.getByRole("button", { name: "Weekdays" }));
		expect(screen.getByRole("button", { name: "Sat" }).getAttribute("aria-pressed")).toBe("false");
		expect(screen.getByRole("button", { name: "Sun" }).getAttribute("aria-pressed")).toBe("false");

		await user.click(screen.getByRole("button", { name: "Create" }));
		expect(api.request.createAutomation).toHaveBeenCalledWith(
			expect.objectContaining({ rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0" }),
		);
	});

	it("uses the Israeli work week (Sun–Thu) when the timezone is Asia/Jerusalem", async () => {
		const user = userEvent.setup();
		renderCreate();
		await fillNameAndPrompt(user);
		await setTimezone(user, "Asia/Jerusalem");

		await user.click(screen.getByRole("button", { name: "Weekdays" }));
		// Sun–Thu are work days; Fri–Sat are the weekend.
		for (const day of ["Sun", "Mon", "Tue", "Wed", "Thu"]) {
			expect(screen.getByRole("button", { name: day }).getAttribute("aria-pressed")).toBe("true");
		}
		for (const day of ["Fri", "Sat"]) {
			expect(screen.getByRole("button", { name: day }).getAttribute("aria-pressed")).toBe("false");
		}

		await user.click(screen.getByRole("button", { name: "Create" }));
		expect(api.request.createAutomation).toHaveBeenCalledWith(
			expect.objectContaining({ rrule: "FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH;BYHOUR=9;BYMINUTE=0" }),
		);
	});

	it("the Weekend preset is Fri–Sat under Asia/Jerusalem", async () => {
		const user = userEvent.setup();
		renderCreate();
		await fillNameAndPrompt(user);
		await setTimezone(user, "Asia/Jerusalem");

		await user.click(screen.getByRole("button", { name: "Weekend" }));
		await user.click(screen.getByRole("button", { name: "Create" }));
		expect(api.request.createAutomation).toHaveBeenCalledWith(
			expect.objectContaining({ rrule: "FREQ=WEEKLY;BYDAY=FR,SA;BYHOUR=9;BYMINUTE=0" }),
		);
	});

	it("disables Save when no day is selected", async () => {
		const user = userEvent.setup();
		renderCreate();
		await fillNameAndPrompt(user);

		// Deselect every day.
		for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
			await user.click(screen.getByRole("button", { name: day }));
		}
		expect(screen.getByText("Pick at least one day.")).toBeTruthy();
		expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("opens an existing weekly rule under the Daily tab with its days lit", () => {
		render(
			<I18nProvider>
				<AutomationEditModal project={project} automation={weeklyAutomation} onClose={() => {}} onSaved={() => {}} />
			</I18nProvider>,
		);
		// No separate Weekly tab exists anymore.
		expect(screen.queryByRole("button", { name: "Weekly" })).toBeNull();
		expect(screen.getByRole("button", { name: "Fri" }).getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByRole("button", { name: "Mon" }).getAttribute("aria-pressed")).toBe("false");
	});
});
