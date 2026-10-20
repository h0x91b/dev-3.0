import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import PortBadgeList, { PORT_BADGE_CAP } from "../PortBadgeList";
import type { PortInfo } from "../../../shared/types";

function makePorts(count: number, from = 51400): PortInfo[] {
	return Array.from({ length: count }, (_, i) => ({ port: from + i, pid: 100 + i, processName: "node" }));
}

function renderList(ports: PortInfo[], onParentClick = vi.fn()) {
	const ui = (list: PortInfo[]) => (
		<I18nProvider>
			<div onClick={onParentClick}>
				<PortBadgeList ports={list} testId="ports" />
			</div>
		</I18nProvider>
	);
	const view = render(ui(ports));
	return { ...view, onParentClick, rerenderPorts: (next: PortInfo[]) => view.rerender(ui(next)) };
}

const portButtons = () => screen.getAllByRole("button", { name: /^Open :\d+ in browser$/ });
const toggle = () => screen.queryByTestId("ports-toggle");

describe("PortBadgeList", () => {
	it("renders a short list in full with no toggle", () => {
		renderList(makePorts(PORT_BADGE_CAP));
		expect(portButtons()).toHaveLength(PORT_BADGE_CAP);
		expect(toggle()).not.toBeInTheDocument();
	});

	it("folds a long list behind a +N toggle and keeps the collapsed list at the cap", () => {
		renderList(makePorts(60));
		expect(portButtons()).toHaveLength(PORT_BADGE_CAP - 1);
		expect(toggle()).toHaveTextContent("+55 more");
		expect(toggle()).toHaveAttribute("aria-expanded", "false");
		expect(toggle()).toHaveAttribute("aria-controls", screen.getByTestId("ports").id);
	});

	it("expands to every port and collapses back", async () => {
		const user = userEvent.setup();
		renderList(makePorts(60));

		await user.click(toggle()!);
		expect(portButtons()).toHaveLength(60);
		expect(toggle()).toHaveTextContent("Show fewer");
		expect(toggle()).toHaveAttribute("aria-expanded", "true");

		await user.click(toggle()!);
		expect(portButtons()).toHaveLength(PORT_BADGE_CAP - 1);
	});

	it("keeps the toggle and the badges from reaching the parent row", async () => {
		const user = userEvent.setup();
		const open = vi.spyOn(window, "open").mockImplementation(() => null);
		const { onParentClick } = renderList(makePorts(60));

		await user.click(toggle()!);
		await user.click(screen.getByRole("button", { name: "Open :51459 in browser" }));

		expect(open).toHaveBeenCalledWith("http://localhost:51459", "_blank");
		expect(onParentClick).not.toHaveBeenCalled();
		open.mockRestore();
	});

	it("stays expanded while live ports come and go, and counts the new tail when collapsed", async () => {
		const user = userEvent.setup();
		const { rerenderPorts } = renderList(makePorts(20));

		rerenderPorts(makePorts(30));
		expect(toggle()).toHaveTextContent("+25 more");

		await user.click(toggle()!);
		rerenderPorts(makePorts(40));
		expect(portButtons()).toHaveLength(40);
		rerenderPorts(makePorts(12));
		expect(portButtons()).toHaveLength(12);
		expect(toggle()).toHaveAttribute("aria-expanded", "true");
	});

	it("drops the toggle when the list shrinks to fit, and starts collapsed when it grows again", async () => {
		const user = userEvent.setup();
		const { rerenderPorts } = renderList(makePorts(20));
		await user.click(toggle()!);

		rerenderPorts(makePorts(3));
		expect(portButtons()).toHaveLength(3);
		expect(toggle()).not.toBeInTheDocument();

		rerenderPorts(makePorts(20));
		expect(portButtons()).toHaveLength(PORT_BADGE_CAP - 1);
		expect(toggle()).toHaveAttribute("aria-expanded", "false");
	});

	it("activates from the keyboard without bubbling", async () => {
		const user = userEvent.setup();
		const { onParentClick } = renderList(makePorts(10));
		toggle()!.focus();
		await user.keyboard("{Enter}");
		expect(portButtons()).toHaveLength(10);
		expect(onParentClick).not.toHaveBeenCalled();
	});
});
