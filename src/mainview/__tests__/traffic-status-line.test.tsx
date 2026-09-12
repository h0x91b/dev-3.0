import { act, render } from "@testing-library/react";
import TrafficStatusLine, {
	STATUS_SWAP_MS,
} from "../components/agent-traffic/TrafficStatusLine";

const live = (container: HTMLElement) =>
	container.querySelector(".traffic-node-status-live")!.textContent;
const ghosts = (container: HTMLElement) =>
	Array.from(container.querySelectorAll(".traffic-node-status-ghost")).map(
		(node) => node.textContent,
	);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("cross-fades one outgoing word and never queues a second", () => {
	const { container, rerender } = render(
		<TrafficStatusLine label="To Do" finished={null} reduced={false} />,
	);
	expect(live(container)).toBe("To Do");
	expect(ghosts(container)).toEqual([]);

	rerender(<TrafficStatusLine label="Agent is Working" finished={null} reduced={false} />);
	expect(live(container)).toBe("Agent is Working");
	expect(ghosts(container)).toEqual(["To Do"]);

	// A second change mid-fade replaces the ghost instead of stacking one.
	rerender(<TrafficStatusLine label="Your Review" finished={null} reduced={false} />);
	expect(live(container)).toBe("Your Review");
	expect(ghosts(container)).toEqual(["Agent is Working"]);

	act(() => void vi.advanceTimersByTime(STATUS_SWAP_MS + 10));
	expect(ghosts(container)).toEqual([]);
	expect(live(container)).toBe("Your Review");
});

it("cross-fades a plain word becoming a verdict stamp", () => {
	const { container, rerender } = render(
		<TrafficStatusLine label="Your Review" finished={null} reduced={false} />,
	);
	rerender(<TrafficStatusLine label="Completed" finished="completed" reduced={false} />);
	expect(container.querySelector(".traffic-node-status-live .traffic-node-stamp")).not.toBeNull();
	const ghost = container.querySelector(".traffic-node-status-ghost")!;
	expect(ghost.textContent).toBe("Your Review");
	expect(ghost.querySelector(".traffic-node-state")).not.toBeNull();
	expect(ghost.getAttribute("aria-hidden")).toBe("true");
});

it("keeps no ghost at all with motion reduced", () => {
	const { container, rerender } = render(
		<TrafficStatusLine label="To Do" finished={null} reduced={true} />,
	);
	rerender(<TrafficStatusLine label="Agent is Working" finished={null} reduced={true} />);
	expect(ghosts(container)).toEqual([]);
	expect(live(container)).toBe("Agent is Working");
});

it("re-renders with an unchanged status without starting a fade", () => {
	const { container, rerender } = render(
		<TrafficStatusLine label="To Do" finished={null} reduced={false} />,
	);
	const before = container.querySelector(".traffic-node-status-live")!;
	rerender(<TrafficStatusLine label="To Do" finished={null} reduced={false} />);
	expect(ghosts(container)).toEqual([]);
	// Same element, so the entrance animation never restarts.
	expect(container.querySelector(".traffic-node-status-live")).toBe(before);
});
