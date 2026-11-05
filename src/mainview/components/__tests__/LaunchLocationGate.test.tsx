import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LaunchLocationGate from "../LaunchLocationGate";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";
import type { LaunchLocationIssue } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: { request: { moveAppToApplications: vi.fn(), quitApp: vi.fn(() => Promise.resolve()) } },
}));

const move = vi.mocked(api.request.moveAppToApplications);

const ISSUE: NonNullable<LaunchLocationIssue> = {
	kind: "translocated",
	bundlePath: "/private/var/folders/x/AppTranslocation/1/d/dev-3.0.app",
	volumePath: "/Volumes/dev-3.0",
	destination: "/Applications/dev-3.0.app",
	reason: "read-only",
};

function renderGate(issue = ISSUE) {
	render(
		<I18nProvider>
			<LaunchLocationGate issue={issue} />
		</I18nProvider>,
	);
}

beforeEach(() => {
	move.mockReset();
	vi.mocked(api.request.quitApp).mockClear();
});

describe("LaunchLocationGate", () => {
	it("explains the installer case and names the destination", () => {
		renderGate();
		expect(screen.getByRole("alertdialog", { name: "Move dev-3.0 to Applications" })).toBeInTheDocument();
		expect(screen.getByText("/Applications/dev-3.0.app")).toBeInTheDocument();
	});

	it("uses the read-only wording for a read-only folder", () => {
		renderGate({ ...ISSUE, kind: "read-only", volumePath: null });
		expect(screen.getByText("dev-3.0 can't update from this folder")).toBeInTheDocument();
	});

	it("cannot be dismissed with Escape or a backdrop click", async () => {
		const user = userEvent.setup();
		renderGate();
		await user.keyboard("{Escape}");
		await user.click(screen.getByTestId("launch-location-gate"));
		expect(screen.getByRole("alertdialog")).toBeInTheDocument();
	});

	it("moves the app and stays in the moving state until the app quits", async () => {
		const user = userEvent.setup();
		move.mockResolvedValue({ ok: true, destination: ISSUE.destination });
		renderGate();
		await user.click(screen.getByRole("button", { name: "Move to Applications" }));
		expect(move).toHaveBeenCalledOnce();
		expect(await screen.findByRole("button", { name: "Moving…" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Quit" })).toBeDisabled();
	});

	it("shows the error, manual steps and a retry when the move fails", async () => {
		const user = userEvent.setup();
		move.mockResolvedValue({ ok: false, error: "Copying dev3 failed: disk full" });
		renderGate();
		await user.click(screen.getByRole("button", { name: "Move to Applications" }));
		expect(await screen.findByText("Couldn't move dev-3.0: Copying dev3 failed: disk full")).toBeInTheDocument();
		expect(screen.getByText(/drag it into Applications in Finder/)).toBeInTheDocument();
		move.mockResolvedValue({ ok: true, destination: ISSUE.destination });
		await user.click(screen.getByRole("button", { name: "Try again" }));
		expect(move).toHaveBeenCalledTimes(2);
	});

	it("quits on Quit", async () => {
		const user = userEvent.setup();
		renderGate();
		await user.click(screen.getByRole("button", { name: "Quit" }));
		expect(api.request.quitApp).toHaveBeenCalledOnce();
	});
});
