import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HelpOverlay from "../HelpOverlay";
import { I18nProvider } from "../../i18n";

const createdZones: HTMLElement[] = [];

/** Give a zone element a real on-screen rect (happy-dom returns zeros). */
function makeZone(helpId: string, rect: { top: number; left: number; width: number; height: number }) {
	const el = document.createElement("div");
	createdZones.push(el);
	el.setAttribute("data-help-id", helpId);
	el.getBoundingClientRect = () =>
		({
			top: rect.top,
			left: rect.left,
			width: rect.width,
			height: rect.height,
			right: rect.left + rect.width,
			bottom: rect.top + rect.height,
			x: rect.left,
			y: rect.top,
			toJSON: () => ({}),
		}) as DOMRect;
	document.body.appendChild(el);
	return el;
}

function renderOverlay(onExit = vi.fn()) {
	const utils = render(
		<I18nProvider>
			<HelpOverlay onExit={onExit} />
		</I18nProvider>,
	);
	return { onExit, ...utils };
}

describe("HelpOverlay", () => {
	afterEach(() => {
		// Remove only our zone elements — nuking body.innerHTML would rip React's
		// portal container out from under the still-mounted overlay.
		for (const el of createdZones.splice(0)) el.remove();
	});

	it("exits immediately when no help zones are on screen", () => {
		const { onExit } = renderOverlay();
		expect(onExit).toHaveBeenCalled();
	});

	it("renders one badge per registered zone, deduped by topic id", () => {
		makeZone("header.utilities", { top: 10, left: 500, width: 200, height: 30 });
		makeZone("board.task-card", { top: 100, left: 20, width: 180, height: 90 });
		makeZone("board.task-card", { top: 200, left: 20, width: 180, height: 90 });
		makeZone("not.a.topic", { top: 300, left: 20, width: 100, height: 40 });
		renderOverlay();
		const badges = screen.getAllByTestId("help-badge");
		expect(badges).toHaveLength(2);
	});

	it("opens the topic HelpCard when a badge is clicked", async () => {
		const user = userEvent.setup();
		makeZone("board.task-card", { top: 100, left: 20, width: 180, height: 90 });
		renderOverlay();
		await user.click(screen.getByTestId("help-badge"));
		expect(screen.getByRole("dialog", { name: "Task card" })).toBeInTheDocument();
	});

	it("clicking the backdrop closes the card first, then exits", async () => {
		const user = userEvent.setup();
		makeZone("board.task-card", { top: 100, left: 20, width: 180, height: 90 });
		const { onExit } = renderOverlay();
		await user.click(screen.getByTestId("help-badge"));
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		await user.click(screen.getByTestId("help-overlay-backdrop"));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(onExit).not.toHaveBeenCalled();
		await user.click(screen.getByTestId("help-overlay-backdrop"));
		expect(onExit).toHaveBeenCalled();
	});

	// A conditional readout (the memory pill, the remote connection readout) renders
	// only while it has bad news, so it can unmount and remount while help mode is
	// open. The captured node is then detached and measures 0×0, which used to put
	// the badge, the outline and the card in the top-left corner of the screen.
	it("follows a zone whose element was replaced while the mode was open", async () => {
		const user = userEvent.setup();
		const first = makeZone("header.memory", { top: 40, left: 700, width: 60, height: 24 });
		renderOverlay();
		expect(screen.getByTestId("help-badge").style.left).toBe("692px");

		first.remove();
		makeZone("header.memory", { top: 40, left: 400, width: 60, height: 24 });
		await user.click(screen.getByTestId("help-badge"));

		expect(screen.getByTestId("help-badge").style.left).toBe("392px");
		const card = screen.getByRole("dialog");
		expect(card.style.left).not.toBe("8px");
		expect(card.style.visibility).toBe("visible");
	});

	it("drops the badge of a zone whose element left the screen entirely", async () => {
		const user = userEvent.setup();
		const conditional = makeZone("header.memory", { top: 40, left: 700, width: 60, height: 24 });
		makeZone("board.task-card", { top: 100, left: 20, width: 180, height: 90 });
		renderOverlay();
		expect(screen.getAllByTestId("help-badge")).toHaveLength(2);

		// The readout went quiet and unmounted; the next render must not keep a
		// marker pinned to a node that is no longer anywhere.
		conditional.remove();
		await user.click(screen.getAllByTestId("help-badge")[1]);
		const left = screen.getAllByTestId("help-badge");
		expect(left).toHaveLength(1);
		expect(left[0].getAttribute("data-help-badge")).toBe("board.task-card");
	});

	it("Escape exits the mode when no card is open", async () => {
		const user = userEvent.setup();
		makeZone("header.utilities", { top: 10, left: 500, width: 200, height: 30 });
		const { onExit } = renderOverlay();
		await user.keyboard("{Escape}");
		expect(onExit).toHaveBeenCalled();
	});
});
