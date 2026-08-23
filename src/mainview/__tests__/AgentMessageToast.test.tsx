import type { ReactElement } from "react";
import { act, render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../i18n";
import { AgentMessageToast, MAX_AGENT_LEGS, sharedParticipant } from "../components/AgentMessageToast";
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

	it("keeps the receiver as the hub when the second message repeats the same pair", () => {
		// Both ends match here; picking the sender would turn "received from #7"
		// into "#7 sent to me" the moment a second message lands.
		const lone = group([link(7, 42)]);
		expect(sharedParticipant(lone, link(7, 42))).toBe("t-42");
	});
});

describe("AgentMessageToast", () => {
	it("puts the receiving task in the hub box and the sender on its own leg", async () => {
		const onOpenFrom = vi.fn();
		const onOpenTo = vi.fn();
		render(<AgentMessageToast group={group([link(7, 42, { onOpenFrom, onOpenTo })])} />);

		expect(screen.getByText("received")).toBeInTheDocument();
		expect(screen.getByText("message 1")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "task #42 Task 42" }));
		await userEvent.click(screen.getByRole("button", { name: /open the sending task #7/ }));
		expect(onOpenTo).toHaveBeenCalledTimes(1);
		expect(onOpenFrom).toHaveBeenCalledTimes(1);
	});

	it("puts every counterpart of a fan-out under the sent block", () => {
		render(<AgentMessageToast group={group([link(7, 42), link(7, 43)], "t-7")} />);

		expect(screen.getByText("sent")).toBeInTheDocument();
		expect(screen.queryByText("received")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /open the receiving task #42/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /open the receiving task #43/ })).toBeInTheDocument();
	});

	it("reads the same in reverse: tasks answering one hub", () => {
		render(<AgentMessageToast group={group([link(42, 7), link(43, 7)], "t-7")} />);

		expect(screen.getByText("received")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /open the sending task #43/ })).toBeInTheDocument();
	});

	it("splits the two directions into their own blocks", () => {
		render(<AgentMessageToast group={group([link(7, 42), link(43, 7)], "t-7")} />);
		expect(screen.getByText("received")).toBeInTheDocument();
		expect(screen.getByText("sent")).toBeInTheDocument();
	});

	it("folds repeat messages from one counterpart into a single box with a count", () => {
		const links = Array.from({ length: 5 }, () => link(1141, 7));
		render(<AgentMessageToast group={group(links, "t-7")} />);

		// One box, not five, and the newest text is the one on screen.
		expect(screen.getAllByRole("button", { name: /open the sending task #1141/ })).toHaveLength(1);
		expect(screen.getByText("×5")).toBeInTheDocument();
		expect(screen.getByText("message 5")).toBeInTheDocument();
		expect(screen.queryByText("message 1")).not.toBeInTheDocument();
	});

	it("collapses the tail into a +N line instead of growing past the screen", () => {
		const links = Array.from({ length: MAX_AGENT_LEGS + 2 }, (_, index) => link(7, 100 + index));
		render(<AgentMessageToast group={group(links, "t-7")} />);

		expect(screen.getByText("+2 more")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /open the receiving task #102/ })).not.toBeInTheDocument();
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

	it("folds a burst around one hub onto one card", () => {
		render(<ToastHost />);
		raise(7, 42, "one");
		raise(7, 43, "two");
		raise(44, 7, "three");

		expect(screen.getAllByRole("alert")).toHaveLength(1);
		expect(screen.getByText("sent")).toBeInTheDocument();
		expect(screen.getByText("received")).toBeInTheDocument();
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

		// The pack and the error, not three cards and not an error folded into the composition.
		expect(screen.getAllByRole("alert")).toHaveLength(2);
		expect(screen.getByText("worktree failed")).toBeInTheDocument();
		expect(screen.getAllByRole("button", { name: /open the receiving task #4[23]/ })).toHaveLength(2);
	});
});
