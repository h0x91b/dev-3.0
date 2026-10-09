import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TerminalLinkSheet from "../TerminalLinkSheet";
import { I18nProvider } from "../../i18n";
import type { TouchLink } from "../../terminal-touch-links";

const copyTextToClipboard = vi.fn<(text: string) => Promise<boolean>>();
vi.mock("../../utils/clipboard", () => ({ copyTextToClipboard: (text: string) => copyTextToClipboard(text) }));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("../../toast", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));

function renderSheet(link: TouchLink | null) {
	const onClose = vi.fn();
	render(
		<I18nProvider>
			<TerminalLinkSheet link={link} onClose={onClose} taskId="task-1" />
		</I18nProvider>,
	);
	return onClose;
}

const web = (): TouchLink => ({ kind: "web", target: "https://example.com/issue-1811", open: vi.fn() });

describe("TerminalLinkSheet", () => {
	beforeEach(() => {
		copyTextToClipboard.mockReset();
		toastSuccess.mockReset();
		toastError.mockReset();
	});

	it("renders nothing without a link", () => {
		renderSheet(null);
		expect(screen.queryByTestId("terminal-link-sheet")).toBeNull();
	});

	it("shows the full destination, not just the label", () => {
		renderSheet(web());
		expect(screen.getByRole("dialog", { name: "Link" })).toBeTruthy();
		expect(screen.getByTestId("terminal-link-sheet-target").textContent).toBe("https://example.com/issue-1811");
	});

	it("opens only on the explicit Open button, then closes", async () => {
		const link = web();
		const onClose = renderSheet(link);
		expect(link.open).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "Open link" }));
		expect(link.open).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalled();
	});

	it("copies the destination and confirms it", async () => {
		copyTextToClipboard.mockResolvedValue(true);
		const link = web();
		const onClose = renderSheet(link);
		await userEvent.click(screen.getByRole("button", { name: "Copy link" }));
		expect(copyTextToClipboard).toHaveBeenCalledWith("https://example.com/issue-1811");
		await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Link copied", expect.anything()));
		expect(onClose).toHaveBeenCalled();
		expect(link.open).not.toHaveBeenCalled();
	});

	it("keeps the sheet open with an error when the copy fails, so the text can be selected", async () => {
		copyTextToClipboard.mockResolvedValue(false);
		const onClose = renderSheet(web());
		await userEvent.click(screen.getByRole("button", { name: "Copy link" }));
		await waitFor(() => expect(toastError).toHaveBeenCalled());
		expect(onClose).not.toHaveBeenCalled();
	});

	it("labels a file link as a path", () => {
		renderSheet({ kind: "file", target: "/repo/src/app.ts", open: vi.fn() });
		expect(screen.getByRole("button", { name: "Open file" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
	});
});
