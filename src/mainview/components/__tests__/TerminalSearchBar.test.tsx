import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Terminal } from "ghostty-web";
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

function renderBar(onClose = vi.fn(), onPaneResolved = vi.fn()) {
	const view = render(
		<I18nProvider>
			<TerminalSearchBar taskId="task-1" onClose={onClose} onPaneResolved={onPaneResolved} />
		</I18nProvider>,
	);
	return { view, onClose, onPaneResolved };
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

	it("reports the resolved pane id to onPaneResolved (for the pane highlight)", async () => {
		const { onPaneResolved } = renderBar();
		await userEvent.type(screen.getByLabelText("Search terminal…"), "needle");
		await waitFor(() => expect(onPaneResolved).toHaveBeenCalledWith("%1"));
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

	describe("native backend (term prop)", () => {
		// 10 scrollback rows + 4 screen rows; "needle" on rows 2, 5 and 11.
		const rows = 4;
		let lines: string[];
		beforeEach(() => {
			lines = Array.from({ length: 14 }, (_, y) => ([2, 5, 11].includes(y) ? `x needle ${y}` : `line ${y}`));
		});
		function fakeTerm() {
			const getLine = vi.fn((y: number) => ({
				length: lines[y].length,
				getCell: (x: number) => ({ getChars: () => lines[y][x], getWidth: () => 1 }),
			}));
			return {
				rows,
				buffer: {
					active: {
						length: lines.length,
						getLine,
					},
				},
				scrollToLine: vi.fn(),
				select: vi.fn(),
				clearSelection: vi.fn(),
			};
		}
		function renderNative(term = fakeTerm()) {
			const onClose = vi.fn();
			const onHighlightChange = vi.fn();
			const view = render(
				<I18nProvider>
					<TerminalSearchBar taskId="task-1" onClose={onClose} term={term as unknown as Terminal} onHighlightChange={onHighlightChange} />
				</I18nProvider>,
			);
			return { term, view, onClose, onHighlightChange };
		}

		it("shows the match count and starts at the newest match without any tmux call", async () => {
			const { term } = renderNative();
			await userEvent.type(screen.getByLabelText("Search terminal…"), "needle");
			await screen.findByText("3");
			// Newest match: row 11 (scrollback 10 → anchor 10, viewport row 1).
			await waitFor(() => expect(term.select).toHaveBeenLastCalledWith(2, 1, 6));
			// Scroll to the anchor, select, then scroll the match into view — in that order.
			const [first, second] = term.scrollToLine.mock.invocationCallOrder.slice(-2);
			expect(first).toBeLessThan(term.select.mock.invocationCallOrder[0]);
			expect(term.select.mock.invocationCallOrder[0]).toBeLessThan(second);
			// Reveal: top row = 11 - 2 = 9, viewportY = 10 - 9 = 1.
			expect(term.scrollToLine).toHaveBeenLastCalledWith(1);
			expect(api.request.tmuxSearchUpdate).not.toHaveBeenCalled();
			expect(api.request.tmuxSearchStep).not.toHaveBeenCalled();
		});

		it("Enter walks older, Shift+Enter newer, both wrap", async () => {
			const { term } = renderNative();
			await userEvent.type(screen.getByLabelText("Search terminal…"), "needle");
			await screen.findByText("3");
			// Each reveal is scrollToLine(anchor), select, scrollToLine(final).
			const lastReveal = () => ({
				anchor: term.scrollToLine.mock.calls[term.scrollToLine.mock.calls.length - 2][0],
				final: term.scrollToLine.mock.calls[term.scrollToLine.mock.calls.length - 1][0],
			});
			await userEvent.keyboard("{Enter}");
			expect(term.select).toHaveBeenLastCalledWith(2, 0, 6);
			expect(lastReveal()).toEqual({ anchor: 5, final: 7 });
			await userEvent.keyboard("{Enter}");
			expect(lastReveal()).toEqual({ anchor: 2, final: 10 });
			await userEvent.keyboard("{Enter}");
			expect(term.select).toHaveBeenLastCalledWith(2, 1, 6);
			await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
			expect(lastReveal()).toEqual({ anchor: 2, final: 10 });
			expect(api.request.tmuxSearchStep).not.toHaveBeenCalled();
		});

		it("re-reads the buffer on Enter, so repainted and new output is seen", async () => {
			const { term } = renderNative();
			await userEvent.type(screen.getByLabelText("Search terminal…"), "needle");
			await screen.findByText("3");
			lines[11] = "OTHER!";
			await userEvent.keyboard("{Enter}");
			await screen.findByText("2");
			expect(term.select).toHaveBeenLastCalledWith(2, 0, 6);
			lines[12] = "new needle";
			await userEvent.keyboard("{Enter}");
			await screen.findByText("3");
			// Wrapped from the oldest to the newest match, the new row 12.
			expect(term.select).toHaveBeenLastCalledWith(4, 2, 6);
		});

		it("clears the selection when every match was overwritten before Enter", async () => {
			const { term } = renderNative();
			await userEvent.type(screen.getByLabelText("Search terminal…"), "needle");
			await screen.findByText("3");
			lines.forEach((l, i) => { if (l.includes("needle")) lines[i] = "OTHER!"; });
			vi.mocked(term.clearSelection).mockClear();
			await userEvent.keyboard("{Enter}");
			await screen.findByText("0");
			expect(term.clearSelection).toHaveBeenCalled();
		});

		it("an empty query reads no buffer lines", async () => {
			const { term } = renderNative();
			await userEvent.type(screen.getByLabelText("Search terminal…"), "a{Backspace}");
			await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
			expect(screen.queryByText("0")).toBeNull();
			expect(term.buffer.active.getLine).not.toHaveBeenCalled();
			await userEvent.keyboard("{Enter}");
			expect(term.buffer.active.getLine).not.toHaveBeenCalled();
		});

		it("a step that finds nothing releases the highlight owner flag", async () => {
			const { onHighlightChange } = renderNative();
			await userEvent.type(screen.getByLabelText("Search terminal…"), "needle");
			await screen.findByText("3");
			expect(onHighlightChange).toHaveBeenLastCalledWith(true);
			for (const y of [2, 5, 11]) lines[y] = `line ${y}`;
			await userEvent.keyboard("{Enter}");
			await screen.findByText("0");
			expect(onHighlightChange).toHaveBeenLastCalledWith(false);
		});

		it("Enter inside the debounce window commits the typed query first and steps from it", async () => {
			const { term } = renderNative();
			await userEvent.type(screen.getByLabelText("Search terminal…"), "needle{Enter}", { delay: null });
			// Update (newest, row 11) then one step older (row 5); the late timer must not undo it.
			expect(term.select).toHaveBeenLastCalledWith(2, 0, 6);
			await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
			expect(term.select).toHaveBeenLastCalledWith(2, 0, 6);
			expect(term.select).toHaveBeenCalledTimes(2);
			// One buffer read for the flushed update; the step reuses its list.
			expect(term.buffer.active.getLine).toHaveBeenCalledTimes(lines.length);
		});

		it("reports highlight ownership: on with a match, off when it goes", async () => {
			const { onHighlightChange } = renderNative();
			const input = screen.getByLabelText("Search terminal…");
			await userEvent.type(input, "needle");
			await screen.findByText("3");
			expect(onHighlightChange).toHaveBeenLastCalledWith(true);
			await userEvent.type(input, "zz");
			await screen.findByText("0");
			expect(onHighlightChange).toHaveBeenLastCalledWith(false);
		});

		it("Enter with an empty query does nothing", async () => {
			const { term } = renderNative();
			await userEvent.keyboard("{Enter}");
			expect(term.select).not.toHaveBeenCalled();
			expect(screen.queryByText("0")).toBeNull();
		});

		it("after no matches, new matches start at the newest again", async () => {
			const { term } = renderNative();
			const input = screen.getByLabelText("Search terminal…");
			await userEvent.type(input, "zzz");
			await screen.findByText("0");
			await userEvent.keyboard("{Enter}");
			await userEvent.clear(input);
			await userEvent.type(input, "needle");
			await screen.findByText("3");
			await userEvent.keyboard("{Enter}");
			expect(term.select).toHaveBeenLastCalledWith(2, 0, 6);
		});

		it("shows 0 and clears the highlight when nothing matches", async () => {
			const { term } = renderNative();
			await userEvent.type(screen.getByLabelText("Search terminal…"), "zzz");
			const counter = await screen.findByText("0");
			expect(counter.className).toContain("text-danger");
			expect(term.select).not.toHaveBeenCalled();
			expect(term.clearSelection).toHaveBeenCalled();
		});

		it("clearSelections on unmount and never cancels tmux copy-mode", async () => {
			const { term, view } = renderNative();
			await userEvent.type(screen.getByLabelText("Search terminal…"), "needle");
			await screen.findByText("3");
			term.clearSelection.mockClear();
			view.unmount();
			expect(term.clearSelection).toHaveBeenCalledTimes(1);
			expect(api.request.tmuxSearchCancel).not.toHaveBeenCalled();
		});
	});
});
