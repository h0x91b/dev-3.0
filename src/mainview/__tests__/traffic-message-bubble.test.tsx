import { render } from "@testing-library/react";
import TrafficMessageBubble from "../components/agent-traffic/TrafficMessageBubble";

it("moves with its route anchor and hides offscreen instead of sticking to the viewport", () => {
	const props = { subject: "Started by a peer agent", width: 800, height: 600, failed: false };
	const { container, rerender } = render(<TrafficMessageBubble {...props} anchor={{ x: 400, y: 300 }} />);
	const bubble = container.firstElementChild as HTMLElement;
	expect(bubble.textContent).toBe(props.subject);
	expect(bubble.style.top).toBe("278px");
	expect(bubble.querySelector(".traffic-message-tail path")?.getAttribute("d")).toBe("M0 0 L10 22 L20 0");
	rerender(<TrafficMessageBubble {...props} anchor={{ x: 410, y: 200 }} />);
	expect(bubble.style.top).toBe("178px");
	for (const anchor of [{ x: 410, y: -10 }, { x: -10, y: 300 }, { x: 810, y: 300 }, { x: 410, y: 610 }]) {
		rerender(<TrafficMessageBubble {...props} anchor={anchor} />);
		expect(bubble.style.visibility).toBe("hidden");
	}
	rerender(<TrafficMessageBubble {...props} anchor={{ x: 400, y: 15 }} />);
	expect(bubble.style.visibility).toBe("");
	expect(bubble).toHaveClass("is-below");
	expect(bubble.style.top).toBe("37px");
});
