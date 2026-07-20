import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TerminalSearchBar from "../TerminalSearchBar";
import { I18nProvider } from "../../i18n";
import { api } from "../../rpc";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			tmuxSearchUpdate: vi.fn(),
			tmuxSearchStep: vi.fn(),
			tmuxSearchCancel: vi.fn(),
		},
	},
}));

function renderBar(onClose = vi.fn()) {
	const view = render(
		<I18nProvider>
			<TerminalSearchBar taskId="task-1" onClose={onClose} />
		</I18nProvider>,
	);
	return { view, onClose };
}

describe("TerminalSearchBar", () => {
	beforeEach(() => {
		vi.mocked(api.request.tmuxSearchUpdate).mockReset().mockResolvedValue({ paneId: "%1", matches: 3 });
		vi.mocked(api.request.tmuxSearchStep).mockReset().mockResolvedValue({ matches: 3 });
		vi.mocked(api.request.tmuxSearchCancel).mockReset().mockResolvedValue(undefined);
	});

	it("focuses the query input on mount", () => {
		renderBar();
		expect(screen.getByLabelText("Search terminal…")).toHaveFocus();
	});

	it("sends the debounced query and shows the match count", async () => {
		renderBar();
		await userEvent.type(screen.getByLabelText("Search terminal…"), "needle");
		await waitFor(() =>
			expect(api.request.tmuxSearchUpdate).toHaveBeenCalledWith({
				taskId: "task-1",
				query: "needle",
				paneId: undefined,
			}),
		);
		await screen.findByText("3");
	});

	it("pins later updates to the pane resolved by the first one", async () => {
		renderBar();
		const input = screen.getByLabelText("Search terminal…");
		await userEvent.type(input, "aa");
		await waitFor(() => expect(api.request.tmuxSearchUpdate).toHaveBeenCalled());
		await userEvent.type(input, "b", { delay: 200 });
		await waitFor(() => {
			const calls = vi.mocked(api.request.tmuxSearchUpdate).mock.calls;
			expect(calls[calls.length - 1][0]).toMatchObject({ paneId: "%1", query: "aab" });
		});
	});

	it("shows a danger-styled 0 when nothing matches", async () => {
		vi.mocked(api.request.tmuxSearchUpdate).mockResolvedValue({ paneId: "%1", matches: 0 });
		renderBar();
		await userEvent.type(screen.getByLabelText("Search terminal…"), "zzz");
		const counter = await screen.findByText("0");
		expect(counter.className).toContain("text-danger");
	});

	it("Enter steps to an older match, Shift+Enter to a newer one", async () => {
		renderBar();
		const input = screen.getByLabelText("Search terminal…");
		await userEvent.type(input, "needle");
		await screen.findByText("3");
		await userEvent.keyboard("{Enter}");
		await waitFor(() =>
			expect(api.request.tmuxSearchStep).toHaveBeenCalledWith({ taskId: "task-1", paneId: "%1", direction: "older" }),
		);
		await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
		await waitFor(() =>
			expect(api.request.tmuxSearchStep).toHaveBeenCalledWith({ taskId: "task-1", paneId: "%1", direction: "newer" }),
		);
	});

	it("restarts the search when a step returns 0 (pane left copy-mode externally)", async () => {
		renderBar();
		await userEvent.type(screen.getByLabelText("Search terminal…"), "needle");
		await screen.findByText("3");
		const updatesBefore = vi.mocked(api.request.tmuxSearchUpdate).mock.calls.length;
		vi.mocked(api.request.tmuxSearchStep).mockResolvedValue({ matches: 0 });
		await userEvent.keyboard("{Enter}");
		await waitFor(() => {
			const calls = vi.mocked(api.request.tmuxSearchUpdate).mock.calls;
			expect(calls.length).toBe(updatesBefore + 1);
			expect(calls[calls.length - 1][0]).toMatchObject({ query: "needle", paneId: "%1" });
		});
	});

	it("step buttons stay disabled without matches", async () => {
		vi.mocked(api.request.tmuxSearchUpdate).mockResolvedValue({ paneId: "%1", matches: 0 });
		renderBar();
		await userEvent.type(screen.getByLabelText("Search terminal…"), "zzz");
		await screen.findByText("0");
		expect(screen.getByLabelText("Older match (Enter)")).toBeDisabled();
		expect(screen.getByLabelText("Newer match (Shift+Enter)")).toBeDisabled();
	});

	it("Escape and the ✕ button close the bar", async () => {
		const { onClose } = renderBar();
		await userEvent.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalledTimes(1);
		await userEvent.click(screen.getByLabelText("Close search (Esc)"));
		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it("cancels copy-mode in the pinned pane on unmount", async () => {
		const { view } = renderBar();
		await userEvent.type(screen.getByLabelText("Search terminal…"), "needle");
		await screen.findByText("3");
		view.unmount();
		expect(api.request.tmuxSearchCancel).toHaveBeenCalledWith({ taskId: "task-1", paneId: "%1" });
	});

	it("does not cancel on unmount when no pane was ever resolved", () => {
		const { view } = renderBar();
		view.unmount();
		expect(api.request.tmuxSearchCancel).not.toHaveBeenCalled();
	});
});
