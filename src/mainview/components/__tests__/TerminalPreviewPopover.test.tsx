import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import TerminalPreviewPopover from "../TerminalPreviewPopover";
import { I18nProvider } from "../../i18n";

vi.mock("../../rpc", () => ({
	api: { request: {} },
}));

const baseState = {
	open: true,
	html: null,
	loading: false,
	pos: { top: 0, left: 0 },
	activeTaskId: "t1",
	cancelClose: vi.fn(),
	scheduleClose: vi.fn(),
};

function renderPopover(props: Record<string, unknown>) {
	return render(
		<I18nProvider>
			<TerminalPreviewPopover {...baseState} {...props} />
		</I18nProvider>,
	);
}

describe("TerminalPreviewPopover — attention banner", () => {
	it("renders the attention reason banner when a reason is set", () => {
		renderPopover({ taskId: "t1", projectId: "p1", attentionReasons: ["PR is ready for review"] });
		expect(screen.getByText("PR is ready for review")).toBeTruthy();
	});

	it("renders all accumulated reasons", () => {
		renderPopover({ taskId: "t1", projectId: "p1", attentionReasons: ["one", "two", "three"] });
		expect(screen.getByText("one")).toBeTruthy();
		expect(screen.getByText("two")).toBeTruthy();
		expect(screen.getByText("three")).toBeTruthy();
	});

	it("does not render the banner when there are no reasons", () => {
		renderPopover({ taskId: "t1", projectId: "p1", overview: "some overview" });
		expect(screen.queryByText("PR is ready for review")).toBeNull();
	});

	it("ignores empty/whitespace-only reasons", () => {
		renderPopover({ taskId: "t1", projectId: "p1", attentionReasons: ["   ", ""] });
		// Banner suppressed → the overview-empty fallback isn't shown as a reason.
		expect(screen.queryByText("Attention")).toBeNull();
	});

	it("shows the banner even when there is no overview to display", () => {
		renderPopover({ taskId: "t1", projectId: "p1", attentionReasons: ["needs your input"] });
		expect(screen.getByText("needs your input")).toBeTruthy();
	});
});
