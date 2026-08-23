import type { ReactElement } from "react";
import { act, render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../i18n";
import { AgentMessageToast, MAX_AGENT_NODES, sharedParticipant } from "../components/AgentMessageToast";
import type { AgentToastGroup, AgentToastLink } from "../components/AgentMessageToast";
import { _resetPendingToastsForTests, ToastHost, toast } from "../toast";

function render(ui: ReactElement) {
	return rtlRender(<I18nProvider>{ui}</I18nProvider>);
}

function link(from: number, to: number, extra: Partial<AgentToastLink> = {}): AgentToastLink {
	return {
		fromTaskId: `t-${from}`,
		fromSeq: from,
		fromTitle: `Task ${from}`,
		toTaskId: `t-${to}`,
		toSeq: to,
		toTitle: `Task ${to}`,
		onOpenFrom: () => {},
		onOpenTo: () => {},
		...extra,
	};
}

function group(links: AgentToastLink[], hubTaskId?: string): AgentToastGroup {
	return {
		hubTaskId,
		items: links.map((l, index) => ({ id: index + 1, link: l, preview: `message ${index + 1}` })),
	};
}

describe("sharedParticipant", () => {
	it("takes a message that touches the established hub, from either side", () => {
		const g = group([link(7, 42), link(7, 43)], "t-7");
		expect(sharedParticipant(g, link(7, 44))).toBe("t-7");
		expect(sharedParticipant(g, link(44, 7))).toBe("t-7");
	});

	it("refuses a message that misses the hub even when the two tasks are related", () => {
		const g = group([link(7, 42), link(7, 43)], "t-7");
		expect(sharedParticipant(g, link(42, 43))).toBeUndefined();
	});

	it("promotes the shared endpoint of a lone message into the hub", () => {
		const lone = group([link(7, 42)]);
		expect(sharedParticipant(lone, link(7, 43))).toBe("t-7");
		expect(sharedParticipant(lone, link(43, 42))).toBe("t-42");
		expect(sharedParticipant(lone, link(50, 51))).toBeUndefined();
	});
});

describe("AgentMessageToast", () => {
	it("renders a single message as two squares that open either side", async () => {
		const onOpenFrom = vi.fn();
		const onOpenTo = vi.fn();
		render(<AgentMessageToast group={group([link(7, 42, { onOpenFrom, onOpenTo })])} />);

		await userEvent.click(screen.getByRole("button", { name: "sent: task #7 Task 7" }));
		await userEvent.click(screen.getByRole("button", { name: "received: task #42 Task 42" }));
		expect(onOpenFrom).toHaveBeenCalledTimes(1);
		expect(onOpenTo).toHaveBeenCalledTimes(1);
	});

	it("draws one node per counterpart around the hub, and names the direction", () => {
		render(<AgentMessageToast group={group([link(7, 42), link(7, 43), link(7, 44)], "t-7")} />);

		expect(screen.getByText("wrote to 3")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /open the receiving task #42/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /open the receiving task #44/ })).toBeInTheDocument();
	});

	it("reads the same in reverse: three tasks answering one hub", () => {
		render(<AgentMessageToast group={group([link(42, 7), link(43, 7), link(44, 7)], "t-7")} />);

		expect(screen.getByText("answered by 3")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /open the sending task #43/ })).toBeInTheDocument();
	});

	it("counts both directions when the hub is sending and receiving at once", () => {
		render(<AgentMessageToast group={group([link(7, 42), link(43, 7)], "t-7")} />);
		expect(screen.getByText("1 sent · 1 received")).toBeInTheDocument();
	});

	it("collapses the tail into a +N line instead of growing past the screen", () => {
		const links = Array.from({ length: MAX_AGENT_NODES + 2 }, (_, index) => link(7, 100 + index));
		render(<AgentMessageToast group={group(links, "t-7")} />);

		expect(screen.getByText("+2 more")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /open the receiving task #105/ })).not.toBeInTheDocument();
	});
});

describe("agent toast grouping in the host", () => {
	afterEach(() => {
		_resetPendingToastsForTests();
	});

	function raise(from: number, to: number, message: string): void {
		act(() => {
			toast.agent(message, { agent: link(from, to) });
		});
	}

	it("folds a burst around one hub onto one card", async () => {
		render(<ToastHost />);
		raise(7, 42, "one");
		raise(7, 43, "two");
		raise(44, 7, "three");

		expect(screen.getAllByRole("alert")).toHaveLength(1);
		expect(screen.getByText("2 sent · 1 received")).toBeInTheDocument();
	});

	it("keeps an unrelated pair on its own card", () => {
		render(<ToastHost />);
		raise(7, 42, "one");
		raise(80, 81, "unrelated");

		expect(screen.getAllByRole("alert")).toHaveLength(2);
	});

	it("does not swallow toasts of other kinds into the pack", () => {
		render(<ToastHost />);
		raise(7, 42, "one");
		act(() => {
			toast.error("worktree failed");
		});
		raise(7, 43, "two");

		// The pack and the error, not three cards and not an error folded into the graph.
		expect(screen.getAllByRole("alert")).toHaveLength(2);
		expect(screen.getByText("worktree failed")).toBeInTheDocument();
		expect(screen.getByText("wrote to 2")).toBeInTheDocument();
	});
});
