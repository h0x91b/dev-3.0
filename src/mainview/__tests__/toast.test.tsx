import type { ReactElement } from "react";
import { act, fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../i18n";
import { createPortal } from "react-dom";
import { _setToastArmDelayForTests, setToastSuppressed, taskToastContext, ToastHost, toast, usePinnedToastSlot } from "../toast";

/** `ToastHost` localizes its dismiss label, so every render needs the provider. */
function render(ui: ReactElement) {
	return rtlRender(<I18nProvider>{ui}</I18nProvider>);
}

function toastCard(): Element {
	const card = screen.getByRole("alert").querySelector("[data-toast-card]");
	if (!card) throw new Error("toast card not found");
	return card;
}

function swipe(el: Element, dx: number): void {
	fireEvent.pointerDown(el, { pointerId: 1, clientX: 0 });
	fireEvent.pointerMove(el, { pointerId: 1, clientX: dx });
	fireEvent.pointerUp(el, { pointerId: 1, clientX: dx });
}

function setRendererActivity(visible: boolean, focused: boolean): void {
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		value: visible ? "visible" : "hidden",
	});
	Object.defineProperty(document, "hasFocus", {
		configurable: true,
		value: () => focused,
	});
	act(() => {
		document.dispatchEvent(new Event("visibilitychange"));
		window.dispatchEvent(new Event(focused ? "focus" : "blur"));
	});
}

function setViewport(width: number): () => void {
	const originalInnerWidth = window.innerWidth;
	const originalMatchMedia = window.matchMedia;
	Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		value: (query: string) => ({
			matches: query.includes("max-width: 767px") ? width < 768 : query.includes("prefers-reduced-motion"),
			media: query,
			onchange: null,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
			dispatchEvent: () => false,
		}),
	});

	return () => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
		Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
	};
}

beforeEach(() => {
	setRendererActivity(true, true);
});

afterEach(() => {
	act(() => setToastSuppressed(false));
	vi.useRealTimers();
	setRendererActivity(true, true);
});

describe("toast service", () => {
	it("renders nothing until a toast is emitted", () => {
		render(<ToastHost />);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("shows an error toast with its message", async () => {
		render(<ToastHost />);
		act(() => {
			toast.error("Something broke");
		});
		expect(await screen.findByText("Something broke")).toBeInTheDocument();
		expect(screen.getByRole("alert")).toBeInTheDocument();
	});

	it("stacks multiple toasts", async () => {
		render(<ToastHost />);
		act(() => {
			toast.error("First");
			toast.success("Second");
		});
		expect(await screen.findByText("First")).toBeInTheDocument();
		expect(screen.getByText("Second")).toBeInTheDocument();
		expect(screen.getAllByRole("alert")).toHaveLength(2);
	});

	it("shows only the newest toast in a narrow viewport", () => {
		const restoreViewport = setViewport(390);
		const onTaskOverflow = vi.fn();
		const { unmount } = render(<ToastHost onTaskOverflow={onTaskOverflow} />);
		act(() => {
			toast.info("First", { durationMs: 60_000, taskId: "task-1" });
			toast.success("Newest", { durationMs: 60_000 });
		});

		expect(screen.getAllByRole("alert")).toHaveLength(1);
		expect(screen.queryByText("First")).not.toBeInTheDocument();
		expect(screen.getByText("Newest")).toBeInTheDocument();
		expect(onTaskOverflow).toHaveBeenCalledWith(expect.objectContaining({ message: "First", taskId: "task-1" }));

		unmount();
		restoreViewport();
	});

	it("dismisses a toast when the close button is clicked", async () => {
		const user = userEvent.setup();
		render(<ToastHost />);
		act(() => {
			toast.info("Closable");
		});
		await screen.findByText("Closable");

		await user.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByText("Closable")).not.toBeInTheDocument();
	});

	it("keeps the dismiss button outside the swipe pointer capture", () => {
		render(<ToastHost />);
		act(() => {
			toast.info("Dismiss without swiping", { durationMs: 60_000 });
		});

		const card = toastCard() as HTMLElement;
		const setPointerCapture = vi.fn();
		Object.defineProperty(card, "setPointerCapture", { configurable: true, value: setPointerCapture });

		act(() => {
			fireEvent.pointerDown(screen.getByRole("button", { name: "Dismiss" }), { pointerId: 1, clientX: 0 });
		});
		expect(setPointerCapture).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByText("Dismiss without swiping")).not.toBeInTheDocument();
	});

	it("dismisses a toast on a rightward swipe past the threshold", () => {
		render(<ToastHost />);
		act(() => {
			toast.info("Swipe me away");
		});
		act(() => {
			swipe(toastCard(), 200);
		});
		expect(screen.queryByText("Swipe me away")).not.toBeInTheDocument();
	});

	it("keeps a toast when the swipe stays below the dismiss threshold", () => {
		render(<ToastHost />);
		act(() => {
			toast.info("Not far enough", { durationMs: 60_000 });
		});
		act(() => {
			swipe(toastCard(), 20);
		});
		expect(screen.getByText("Not far enough")).toBeInTheDocument();
		expect((toastCard() as HTMLElement).style.transform).toBe("translateX(0px)");
	});

	it("ignores a leftward drag (right-anchored toast only flings right)", () => {
		render(<ToastHost />);
		act(() => {
			toast.info("Stay put", { durationMs: 60_000 });
		});
		act(() => {
			swipe(toastCard(), -200);
		});
		expect(screen.getByText("Stay put")).toBeInTheDocument();
	});

	it("suppresses the click that follows a drag on a clickable toast", () => {
		const onClick = vi.fn();
		render(<ToastHost />);
		act(() => {
			toast.info("Open task", { onClick, durationMs: 60_000 });
		});
		const alert = screen.getByRole("alert");
		const card = alert.querySelector("[data-toast-card]") as Element;
		act(() => {
			fireEvent.pointerDown(card, { pointerId: 1, clientX: 0 });
			fireEvent.pointerMove(card, { pointerId: 1, clientX: 30 });
			fireEvent.pointerUp(card, { pointerId: 1, clientX: 30 });
		});
		// The browser fires a click after the drag ends — it must be swallowed.
		fireEvent.click(within(alert).getByRole("button", { name: "Open task" }));
		expect(onClick).not.toHaveBeenCalled();
		expect(screen.getByText("Open task")).toBeInTheDocument();
	});

	it("captures the pointer only once a drag starts (a tap must stay clickable)", () => {
		render(<ToastHost />);
		act(() => {
			toast.info("Tap me", { onClick: vi.fn(), durationMs: 60_000 });
		});

		const card = toastCard() as HTMLElement;
		const setPointerCapture = vi.fn();
		Object.defineProperty(card, "setPointerCapture", { configurable: true, value: setPointerCapture });

		act(() => {
			fireEvent.pointerDown(card, { pointerId: 1, clientX: 0 });
			fireEvent.pointerMove(card, { pointerId: 1, clientX: 4 });
		});
		expect(setPointerCapture).not.toHaveBeenCalled();

		act(() => {
			fireEvent.pointerMove(card, { pointerId: 1, clientX: 40 });
		});
		expect(setPointerCapture).toHaveBeenCalledOnce();
	});

	it("spreads a clickable toast's hit area over the whole card except the dismiss button", () => {
		render(<ToastHost />);
		act(() => {
			toast.info("Whole box", { onClick: vi.fn(), durationMs: 60_000 });
		});

		const card = toastCard() as HTMLElement;
		const overlay = within(card).getByRole("button", { name: "Whole box" });
		expect(overlay.className).toContain("absolute");
		expect(overlay.className).toContain("inset-[3px]");
		expect(overlay.contains(within(card).getByRole("button", { name: "Dismiss" }))).toBe(false);
	});

	it("does not focus a clickable toast on pointer press (no stray focus ring)", async () => {
		const user = userEvent.setup();
		render(<ToastHost />);
		act(() => {
			toast.info("No ring", { onClick: vi.fn(), durationMs: 60_000 });
		});
		const button = within(screen.getByRole("alert")).getByRole("button", { name: "No ring" });
		await user.pointer({ target: button, keys: "[MouseLeft>]" });
		expect(document.activeElement).not.toBe(button);
	});

	it("still runs a clickable toast's action on a plain click (no drag)", async () => {
		const user = userEvent.setup();
		const onClick = vi.fn();
		render(<ToastHost />);
		act(() => {
			toast.info("Go there", { onClick, durationMs: 60_000 });
		});
		await user.click(within(screen.getByRole("alert")).getByRole("button", { name: "Go there" }));
		expect(onClick).toHaveBeenCalledOnce();
		expect(screen.queryByText("Go there")).not.toBeInTheDocument();
	});

	it("fills the source line and click target from a bare taskId", async () => {
		const user = userEvent.setup();
		const openTask = vi.fn();
		const resolveOrigin = vi.fn(() => ({ context: "#42 · dev-3.0 · Fix the thing", onClick: openTask }));
		render(<ToastHost resolveOrigin={resolveOrigin} />);
		act(() => {
			toast.error("Push failed", { taskId: "t1", durationMs: 60_000 });
		});

		expect(resolveOrigin).toHaveBeenCalledWith(expect.objectContaining({ taskId: "t1" }));
		expect(screen.getByText("#42 · dev-3.0 · Fix the thing")).toBeInTheDocument();
		// The source line is part of the accessible name — a screen reader must hear
		// which task the click navigates to.
		const overlay = within(screen.getByRole("alert")).getByRole("button", {
			name: "#42 · dev-3.0 · Fix the thing — Push failed",
		});
		await user.click(overlay);
		expect(openTask).toHaveBeenCalledOnce();
	});

	it("keeps an explicit context and click target over the resolved ones", async () => {
		const user = userEvent.setup();
		const ownClick = vi.fn();
		const resolvedClick = vi.fn();
		const resolveOrigin = () => ({ context: "resolved", onClick: resolvedClick });
		render(<ToastHost resolveOrigin={resolveOrigin} />);
		act(() => {
			toast.info("Open the viewer", {
				taskId: "t1",
				context: "#7 · dev-3.0 · Screenshot task",
				onClick: ownClick,
				durationMs: 60_000,
			});
		});

		expect(screen.queryByText("resolved")).not.toBeInTheDocument();
		await user.click(within(screen.getByRole("alert")).getByRole("button", {
			name: "#7 · dev-3.0 · Screenshot task — Open the viewer",
		}));
		expect(ownClick).toHaveBeenCalledOnce();
		expect(resolvedClick).not.toHaveBeenCalled();
	});

	it("keeps a live toast's source line after the task stops resolving", async () => {
		const user = userEvent.setup();
		const openTask = vi.fn();
		const { rerender } = rtlRender(
			<I18nProvider>
				<ToastHost resolveOrigin={() => ({ context: "#42 · dev-3.0 · Fix the thing", onClick: openTask })} />
			</I18nProvider>,
		);
		act(() => {
			toast.error("Push failed", { taskId: "t1", durationMs: 60_000 });
		});

		// Leaving the project empties the resolver's task list. The toast was raised
		// while the task was known, so it must keep both its identity and its way back.
		rerender(
			<I18nProvider>
				<ToastHost resolveOrigin={() => undefined} />
			</I18nProvider>,
		);
		expect(screen.getByText("#42 · dev-3.0 · Fix the thing")).toBeInTheDocument();
		await user.click(within(screen.getByRole("alert")).getByRole("button", {
			name: "#42 · dev-3.0 · Fix the thing — Push failed",
		}));
		expect(openTask).toHaveBeenCalledOnce();
	});

	it("never fabricates a source line for a task it cannot resolve", () => {
		render(<ToastHost resolveOrigin={() => undefined} />);
		act(() => {
			toast.error("Save failed", { taskId: "gone", durationMs: 60_000 });
		});

		const card = toastCard() as HTMLElement;
		expect(within(card).getByText("Save failed")).toBeInTheDocument();
		// No resolution -> no source line and no click target, just the message.
		expect(within(card).queryByRole("button", { name: /Save failed/ })).not.toBeInTheDocument();
		expect(card.querySelector(".font-mono")).toBeNull();
	});

	it("leaves a toast that names no origin at all bare", () => {
		// The resolver is asked either way; with nothing to resolve it declines,
		// and the host must not invent a line from the app name.
		const resolveOrigin = vi.fn(({ taskId, projectId }) =>
			taskId || projectId ? { context: "never" } : undefined,
		);
		render(<ToastHost resolveOrigin={resolveOrigin} />);
		act(() => {
			toast.error("Could not add the project", { durationMs: 60_000 });
		});
		expect(screen.queryByText("never")).not.toBeInTheDocument();
		expect(toastCard().querySelector(".font-mono")).toBeNull();
	});

	it("renders no line at all when the fallback chain runs out", () => {
		// The fourth case behind task -> project -> area: a resolver that answers but
		// has no line to give. The slot must vanish, never render as an empty row.
		render(<ToastHost resolveOrigin={() => ({ onClick: vi.fn() })} />);
		act(() => {
			toast.error("Nothing to attribute", { taskId: "t1", durationMs: 60_000 });
		});
		const card = toastCard() as HTMLElement;
		expect(card.querySelector(".font-mono")).toBeNull();
		expect(within(card).getByText("Nothing to attribute")).toBeInTheDocument();
	});

	it("falls back from a task to its project", async () => {
		const user = userEvent.setup();
		const openBoard = vi.fn();
		const resolveOrigin = vi.fn(({ taskId }) =>
			taskId ? undefined : { context: "dev-3.0", onClick: openBoard },
		);
		render(<ToastHost resolveOrigin={resolveOrigin} />);
		act(() => {
			toast.success("Project settings saved.", { projectId: "p1", durationMs: 60_000 });
		});

		expect(resolveOrigin).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1" }));
		expect(screen.getByText("dev-3.0")).toBeInTheDocument();
		await user.click(within(screen.getByRole("alert")).getByRole("button", {
			name: "dev-3.0 — Project settings saved.",
		}));
		expect(openBoard).toHaveBeenCalledOnce();
	});

	it("labels an app-area toast without any app state, and without a click target", () => {
		render(<ToastHost />);
		act(() => {
			toast.info("Shortcut reassigned.", { source: "settings", durationMs: 60_000 });
		});

		const card = toastCard() as HTMLElement;
		expect(within(card).getByText("Settings")).toBeInTheDocument();
		// An area is not a destination — nothing to navigate to, so no hit area.
		expect(within(card).queryByRole("button", { name: /Shortcut reassigned/ })).not.toBeInTheDocument();
	});

	it("appends a detail after the resolved origin", () => {
		render(<ToastHost resolveOrigin={() => ({ context: "dev-3.0" })} />);
		act(() => {
			toast.warning("Missed 2 scheduled runs.", {
				projectId: "p1",
				contextDetail: "Nightly digest",
				durationMs: 60_000,
			});
		});
		expect(screen.getByText("dev-3.0 · Nightly digest")).toBeInTheDocument();
	});

	it("paints an agent-to-agent toast in its own hue, not a severity one", () => {
		render(<ToastHost />);
		act(() => {
			toast.agent("“check the payload”", { context: "#7 Coordinator → #42 Receiver" });
		});
		const card = document.querySelector("[data-toast-card]") as HTMLElement;
		expect(card.className).toContain("border-agent/40");
		expect(card.querySelector("[data-toast-progress]")?.className).toContain("bg-agent");
		expect(card.className).not.toContain("border-accent");
		expect(screen.getByText("#7 Coordinator → #42 Receiver")).toBeInTheDocument();
	});

	describe("source-line links and labelled actions", () => {
		function raise(card = vi.fn(), sender = vi.fn(), traffic = vi.fn()) {
			act(() => {
				toast.agent("check the payload", {
					context: "#7 Coordinator → #42 Receiver",
					clickLabel: "Open agent traffic",
					onClick: card,
					contextParts: [
						{ lead: "#7", label: "Coordinator", ariaLabel: "Open sender task #7 Coordinator", onClick: sender },
						"→",
						{ lead: "#42", label: "Receiver", suffix: "· Billing", ariaLabel: "Open recipient task #42", onClick: vi.fn() },
					],
					actions: [
						{ label: "Sender #7", emphasis: true, onClick: sender },
						{ label: "Agent traffic", onClick: traffic },
					],
					durationMs: 60_000,
				});
			});
			return { card, sender, traffic };
		}

		it("runs a link or an action alone, then dismisses — the card's click never fires", async () => {
			render(<ToastHost />);
			const { card, sender } = raise();
			await userEvent.click(screen.getByRole("button", { name: "Open sender task #7 Coordinator" }));
			expect(sender).toHaveBeenCalledTimes(1);
			expect(card).not.toHaveBeenCalled();
			expect(screen.queryByRole("alert")).toBeNull();

			const second = raise();
			await userEvent.click(screen.getByRole("button", { name: "Agent traffic" }));
			expect(second.traffic).toHaveBeenCalledTimes(1);
			expect(second.card).not.toHaveBeenCalled();
		});

		it("names the card's own destination and keeps it clickable", async () => {
			render(<ToastHost />);
			const { card } = raise();
			await userEvent.click(
				screen.getByRole("button", { name: "Open agent traffic: #7 Coordinator → #42 Receiver — check the payload" }),
			);
			expect(card).toHaveBeenCalledTimes(1);
		});

		// Sibling buttons raised above the card's button, never nested inside it.
		it("nests no interactive element inside another", () => {
			render(<ToastHost />);
			raise();
			for (const button of document.querySelectorAll("[data-toast-card] button")) {
				expect(button.querySelector("button")).toBeNull();
			}
			expect(document.querySelector("[data-toast-context]")!.className).toContain("z-10");
			expect(document.querySelector("[data-toast-actions]")!.className).toContain("z-10");
		});

		it("keeps the number whole and lets only the title truncate", () => {
			render(<ToastHost />);
			raise();
			const link = screen.getByRole("button", { name: "Open recipient task #42" });
			const [lead, label, suffix] = Array.from(link.children);
			expect(lead).toHaveTextContent("#42");
			expect(lead!.className).toContain("flex-none");
			expect(label!.className).toContain("truncate");
			expect(suffix).toHaveTextContent("· Billing");
			expect(link.className).toContain("underline");
		});

		// Wrapping moves "→" down with the recipient instead of leaving it on a line alone.
		it("keeps the arrow together with the link after it", () => {
			render(<ToastHost />);
			raise();
			const recipient = screen.getByRole("button", { name: "Open recipient task #42" });
			expect(recipient.parentElement).toHaveTextContent(/^→#42/);
		});

		// Wrapping made the toast a line taller: the row never wraps, and only the
		// action marked `shrink` gives up width (its label truncates).
		it("keeps every action on one row, letting only the shrinkable one truncate", () => {
			render(<ToastHost />);
			act(() => {
				toast.agent("m", {
					actions: [
						{ label: "#7", ariaLabel: "Sender #7", icon: <svg />, onClick: vi.fn() },
						{ label: "Agent traffic", shrink: true, onClick: vi.fn() },
						{ label: "#42", ariaLabel: "Recipient #42", onClick: vi.fn() },
					],
				});
			});
			const row = document.querySelector("[data-toast-actions]") as HTMLElement;
			expect(row.className).toContain("flex-nowrap");
			const [sender, traffic, recipient] = Array.from(row.querySelectorAll("button"));
			expect(sender!.className).toContain("flex-none");
			expect(recipient!.className).toContain("flex-none");
			expect(traffic!.className).toContain("min-w-0");
			expect(traffic!.querySelector(".truncate")).toHaveTextContent("Agent traffic");
			// The compact label is still announced with its role, and the icon is decoration.
			expect(screen.getByRole("button", { name: "Sender #7" })).toHaveAttribute("title", "Sender #7");
			expect(sender!.querySelector("[aria-hidden=true] svg")).not.toBeNull();
		});

		it("does not start a swipe from a press on an action", () => {
			render(<ToastHost />);
			raise();
			const action = screen.getByRole("button", { name: "Sender #7" });
			swipe(action, 400);
			expect(screen.getByRole("alert")).toBeInTheDocument();
		});

		it("pauses its timer while an action holds keyboard focus", async () => {
			const user = userEvent.setup();
			render(<ToastHost />);
			raise();
			await user.tab();
			expect(document.querySelector("[data-toast-progress]") as HTMLElement).toHaveStyle({ animationPlayState: "paused" });
		});
	});

	it("composes a source line with the identifier first", () => {
		expect(taskToastContext(804, "dev-3.0", "Review PR Babysitter")).toBe("#804 · dev-3.0 · Review PR Babysitter");
		expect(taskToastContext(undefined, "dev-3.0", "No seq")).toBeUndefined();
		expect(taskToastContext(12, undefined, undefined)).toBe("#12");
	});

	it("auto-dismisses after the given duration", () => {
		vi.useFakeTimers();
		render(<ToastHost />);
		act(() => {
			toast.error("Temporary", { durationMs: 5000 });
		});
		expect(screen.getByText("Temporary")).toBeInTheDocument();
		act(() => {
			vi.advanceTimersByTime(5000);
		});
		expect(screen.queryByText("Temporary")).not.toBeInTheDocument();
	});

	it("pauses a toast while the renderer is hidden and resumes its remaining time", () => {
		vi.useFakeTimers();
		render(<ToastHost />);
		act(() => {
			toast.info("Hidden", { durationMs: 5000 });
			vi.advanceTimersByTime(2000);
		});

		setRendererActivity(false, false);
		const progress = document.querySelector("[data-toast-progress]") as HTMLElement;
		expect(progress.style.animationPlayState).toBe("paused");
		act(() => {
			vi.advanceTimersByTime(5000);
		});
		expect(screen.getByText("Hidden")).toBeInTheDocument();

		setRendererActivity(true, true);
		act(() => {
			vi.advanceTimersByTime(2999);
		});
		expect(screen.getByText("Hidden")).toBeInTheDocument();
		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(screen.queryByText("Hidden")).not.toBeInTheDocument();
	});

	it("pauses on window blur and starts background toasts with a full budget", () => {
		vi.useFakeTimers();
		render(<ToastHost />);
		act(() => {
			toast.info("Background", { durationMs: 4000 });
		});
		setRendererActivity(true, false);
		const progress = document.querySelector("[data-toast-progress]") as HTMLElement;
		expect(progress.style.animationPlayState).toBe("paused");
		act(() => {
			vi.advanceTimersByTime(10000);
		});
		expect(screen.getByText("Background")).toBeInTheDocument();

		setRendererActivity(true, true);
		act(() => {
			vi.advanceTimersByTime(3999);
		});
		expect(screen.getByText("Background")).toBeInTheDocument();
		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(screen.queryByText("Background")).not.toBeInTheDocument();
	});

	it("pauses and resumes the affected toast while it is hovered", async () => {
		const user = userEvent.setup();
		render(<ToastHost />);
		act(() => {
			toast.info("Hover me", { durationMs: 60_000 });
		});
		const alert = screen.getByRole("alert");
		await user.hover(alert);
		expect(document.querySelector("[data-toast-progress]") as HTMLElement).toHaveStyle({ animationPlayState: "paused" });
		await user.unhover(alert);
		expect(document.querySelector("[data-toast-progress]") as HTMLElement).toHaveStyle({ animationPlayState: "running" });
	});

	it("pauses while a toast contains keyboard focus and resumes when focus leaves", async () => {
		const user = userEvent.setup();
		render(<ToastHost />);
		act(() => toast.info("Focus me", { durationMs: 60_000 }));
		await user.tab();
		expect(screen.getByRole("button", { name: "Dismiss" })).toHaveFocus();
		expect(document.querySelector("[data-toast-progress]") as HTMLElement).toHaveStyle({ animationPlayState: "paused" });
		await user.tab();
		expect(document.querySelector("[data-toast-progress]") as HTMLElement).toHaveStyle({ animationPlayState: "running" });
	});

	it("keeps five newest entries and evicts the oldest regardless of variant or interaction", async () => {
		const user = userEvent.setup();
		const onTaskOverflow = vi.fn();
		render(<ToastHost onTaskOverflow={onTaskOverflow} />);
		act(() => {
			toast.error("Oldest", { durationMs: 60_000, taskId: "task-1" });
		});
		await user.hover(screen.getByRole("alert"));
		act(() => {
			toast.success("Second", { durationMs: 60_000 });
			toast.warning("Third", { durationMs: 60_000 });
			toast.info("Fourth", { durationMs: 60_000 });
			toast.error("Fifth", { durationMs: 60_000 });
			toast.success("Newest", { durationMs: 60_000 });
		});
		expect(screen.getAllByRole("alert")).toHaveLength(5);
		expect(screen.queryByText("Oldest")).not.toBeInTheDocument();
		expect(screen.getByText("Second")).toBeInTheDocument();
		expect(screen.getByText("Newest")).toBeInTheDocument();
		expect(onTaskOverflow).toHaveBeenCalledOnce();
		expect(onTaskOverflow).toHaveBeenCalledWith(expect.objectContaining({ message: "Oldest", taskId: "task-1" }));
	});

	it("keeps only the newest agent toast and never bells the one it replaced", () => {
		const onTaskOverflow = vi.fn();
		render(<ToastHost onTaskOverflow={onTaskOverflow} />);
		act(() => {
			toast.agent("First agent message", { durationMs: 60_000, taskId: "task-1" });
			toast.agent("Second agent message", { durationMs: 60_000, taskId: "task-2" });
		});
		expect(screen.getAllByRole("alert")).toHaveLength(1);
		expect(screen.queryByText("First agent message")).not.toBeInTheDocument();
		expect(screen.getByText("Second agent message")).toBeInTheDocument();
		expect(onTaskOverflow).not.toHaveBeenCalled();
	});

	it("leaves the other four slots to non-agent toasts", () => {
		render(<ToastHost />);
		act(() => {
			toast.agent("Agent message", { durationMs: 60_000 });
			toast.success("Saved", { durationMs: 60_000 });
			toast.error("Failed", { durationMs: 60_000 });
			toast.warning("Careful", { durationMs: 60_000 });
			toast.info("Heads up", { durationMs: 60_000 });
		});
		expect(screen.getAllByRole("alert")).toHaveLength(5);
		expect(screen.getByText("Agent message")).toBeInTheDocument();
	});

	it("does not bell an agent toast pushed out by capacity", () => {
		const onTaskOverflow = vi.fn();
		render(<ToastHost onTaskOverflow={onTaskOverflow} />);
		act(() => {
			toast.agent("Agent message", { durationMs: 60_000, taskId: "task-1" });
			for (let i = 0; i < 5; i++) toast.info(`Info ${i}`, { durationMs: 60_000 });
		});
		expect(screen.queryByText("Agent message")).not.toBeInTheDocument();
		expect(onTaskOverflow).not.toHaveBeenCalled();
	});

	it("offers no Clear all while a single toast owns its own dismiss button", () => {
		render(<ToastHost />);
		act(() => toast.info("Alone", { durationMs: 60_000 }));
		expect(screen.queryByRole("button", { name: /Clear all/ })).not.toBeInTheDocument();
	});

	it("sweeps the whole stack with Clear all and counts what it will clear", async () => {
		const user = userEvent.setup();
		render(<ToastHost />);
		act(() => {
			toast.info("First", { durationMs: 60_000 });
			toast.error("Second", { durationMs: 60_000 });
			toast.success("Third", { durationMs: 60_000 });
		});
		await user.click(screen.getByRole("button", { name: /Clear all/ }));
		expect(screen.queryAllByRole("alert")).toHaveLength(0);
		expect(screen.queryByRole("button", { name: /Clear all/ })).not.toBeInTheDocument();
	});

	it("does not turn a Clear all sweep into attention badges", async () => {
		const user = userEvent.setup();
		const onTaskOverflow = vi.fn();
		render(<ToastHost onTaskOverflow={onTaskOverflow} />);
		act(() => {
			toast.info("First", { durationMs: 60_000, taskId: "task-1" });
			toast.error("Second", { durationMs: 60_000, taskId: "task-2" });
		});
		await user.click(screen.getByRole("button", { name: /Clear all/ }));
		expect(onTaskOverflow).not.toHaveBeenCalled();
	});

	it("pauses every timer while Clear all is hovered so the button cannot slip away", async () => {
		const user = userEvent.setup();
		render(<ToastHost />);
		act(() => {
			toast.info("First", { durationMs: 60_000 });
			toast.error("Second", { durationMs: 60_000 });
		});
		const clearAll = screen.getByRole("button", { name: /Clear all/ });
		expect(document.querySelectorAll("[data-toast-progress]")).toHaveLength(2);
		await user.hover(clearAll);
		for (const bar of document.querySelectorAll("[data-toast-progress]")) {
			expect(bar as HTMLElement).toHaveStyle({ animationPlayState: "paused" });
		}
		await user.unhover(clearAll);
		for (const bar of document.querySelectorAll("[data-toast-progress]")) {
			expect(bar as HTMLElement).toHaveStyle({ animationPlayState: "running" });
		}
	});

	it("does not report unscoped, manually dismissed, or timed-out eviction", () => {
		vi.useFakeTimers();
		const onTaskOverflow = vi.fn();
		const { unmount } = render(<ToastHost onTaskOverflow={onTaskOverflow} />);
		act(() => {
			toast.info("Manual", { durationMs: 1000 });
		});
		act(() => screen.getByRole("button", { name: "Dismiss" }).click());
		act(() => {
			toast.info("Timed", { durationMs: 1000 });
			vi.advanceTimersByTime(1000);
		});
		expect(onTaskOverflow).not.toHaveBeenCalled();
		unmount();
	});

	it("does not throw when no host is mounted", () => {
		expect(() => toast.error("orphan")).not.toThrow();
	});

	// `ToastHost` subscribes from a passive effect, so a push message handled in the
	// window before React flushes it used to drop the toast outright — invisible in
	// production and a source of flaky assertions in tests.
	it("delivers a toast raised before the host subscribed", async () => {
		toast.info("Raised before mount");

		render(<ToastHost />);

		expect(await screen.findByText("Raised before mount")).toBeInTheDocument();
	});

	it("keeps only the newest queued entries when no host ever subscribes", async () => {
		for (let index = 1; index <= 7; index += 1) toast.info(`Queued ${index}`);

		render(<ToastHost />);

		expect(await screen.findByText("Queued 7")).toBeInTheDocument();
		expect(screen.queryByText("Queued 1")).not.toBeInTheDocument();
		expect(screen.queryByText("Queued 2")).not.toBeInTheDocument();
	});

	it("queues toasts while suppressed and flushes them in order", async () => {
		render(<ToastHost />);
		setToastSuppressed(true);
		act(() => {
			toast.info("First queued");
			toast.error("Second queued");
		});

		expect(screen.queryByText("First queued")).not.toBeInTheDocument();
		expect(screen.queryByText("Second queued")).not.toBeInTheDocument();

		act(() => setToastSuppressed(false));
		expect(await screen.findByText("First queued")).toBeInTheDocument();
		expect(screen.getByText("Second queued")).toBeInTheDocument();
	});
});

describe("ToastHost — the pinned slot owns the corner with the toasts", () => {
	function Pinned() {
		const slot = usePinnedToastSlot();
		return slot ? createPortal(<div data-testid="pinned">Update ready</div>, slot) : null;
	}

	it("exposes the slot with an empty stack, because that is when a prompt needs it most", () => {
		render(<><ToastHost /><Pinned /></>);
		expect(screen.getByTestId("pinned")).toBeInTheDocument();
	});

	it("keeps the pinned surface above the toasts inside one stack", async () => {
		render(<><ToastHost /><Pinned /></>);
		act(() => toast.info("Agent shared 2 images"));

		const pinned = await screen.findByTestId("pinned");
		const card = toastCard();
		// Same fixed container: neither can cover the other, whatever either one's height.
		const stack = pinned.closest("div.fixed");
		expect(stack).not.toBeNull();
		expect(stack?.contains(card)).toBe(true);
		// Pinned first in DOM order, so it renders at the top of the column.
		expect(pinned.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

});

describe("toast stack stability", () => {
	// The reported "sometimes it opens an artifact": the old agent toast was removed
	// and the new one appended, so the toast below slid up into the slot the pointer
	// was aimed at.
	it("puts a newer agent message in its predecessor's slot, not at the bottom", () => {
		render(<ToastHost />);
		act(() => {
			toast.agent("First agent message", { durationMs: 60_000 });
			toast.info("Artifact shared", { durationMs: 60_000, onClick: () => {} });
			toast.agent("Second agent message", { durationMs: 60_000 });
		});
		expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toEqual([
			expect.stringContaining("Second agent message"),
			expect.stringContaining("Artifact shared"),
		]);
	});

	it("keeps every other toast when an agent message replaces another at full capacity", () => {
		render(<ToastHost />);
		act(() => {
			toast.agent("First agent message", { durationMs: 60_000 });
			for (let i = 0; i < 4; i++) toast.info(`Info ${i}`, { durationMs: 60_000 });
			toast.agent("Second agent message", { durationMs: 60_000 });
		});
		expect(screen.getAllByRole("alert")).toHaveLength(5);
		expect(screen.getAllByRole("alert")[0]).toHaveTextContent("Second agent message");
		for (let i = 0; i < 4; i++) expect(screen.getByText(`Info ${i}`)).toBeInTheDocument();
	});
});

describe("toast arming against stray clicks", () => {
	let now = 1_000_000;

	beforeEach(() => {
		now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		_setToastArmDelayForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function raiseClickable() {
		const card = vi.fn();
		const link = vi.fn();
		const action = vi.fn();
		act(() => {
			toast.agent("Status update", {
				durationMs: 60_000,
				clickLabel: "Open sender",
				onClick: card,
				contextParts: [{ lead: "#7", label: "Sender", ariaLabel: "Open sender task #7", onClick: link }, "→", "#42"],
				actions: [{ label: "#42", ariaLabel: "Recipient #42", onClick: action }],
			});
		});
		return { card, link, action };
	}

	it("ignores a pointer click pressed right after the toast appeared, on every destination", async () => {
		render(<ToastHost />);
		const { card, link, action } = raiseClickable();
		now += 100;

		await userEvent.click(screen.getByRole("button", { name: /^Open sender:/ }));
		await userEvent.click(screen.getByRole("button", { name: "Open sender task #7" }));
		await userEvent.click(screen.getByRole("button", { name: "Recipient #42" }));

		expect(card).not.toHaveBeenCalled();
		expect(link).not.toHaveBeenCalled();
		expect(action).not.toHaveBeenCalled();
		// Nothing was chosen, so nothing was answered: the toast stays.
		expect(screen.getByRole("alert")).toBeInTheDocument();
	});

	it("runs a deliberate pointer click once the toast has settled", async () => {
		render(<ToastHost />);
		const { card } = raiseClickable();
		now += 700;

		await userEvent.click(screen.getByRole("button", { name: /^Open sender:/ }));

		expect(card).toHaveBeenCalledOnce();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("never delays keyboard activation", async () => {
		render(<ToastHost />);
		const { action } = raiseClickable();

		screen.getByRole("button", { name: "Recipient #42" }).focus();
		await userEvent.keyboard("{Enter}");

		expect(action).toHaveBeenCalledOnce();
	});

	it("dismisses at once — closing navigates nowhere, so it needs no guard", async () => {
		render(<ToastHost />);
		const { card, link, action } = raiseClickable();

		await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(card).not.toHaveBeenCalled();
		expect(link).not.toHaveBeenCalled();
		expect(action).not.toHaveBeenCalled();
	});

	it("re-arms a toast that slid into a new slot under the pointer", async () => {
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			const index = Array.from(document.querySelectorAll("[data-toast-id]")).indexOf(this);
			return { top: Math.max(0, index) * 120, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
		});
		const below = vi.fn();
		render(<ToastHost />);
		act(() => {
			toast.info("Above", { durationMs: 60_000 });
			toast.info("Below", { durationMs: 60_000, onClick: below });
		});
		now += 5_000;
		await userEvent.click(within(screen.getAllByRole("alert")[0]!).getByRole("button", { name: "Dismiss" }));

		// "Below" just moved up into the slot the pointer was on.
		now += 100;
		await userEvent.click(screen.getByRole("button", { name: /Below/ }));
		expect(below).not.toHaveBeenCalled();

		now += 700;
		await userEvent.click(screen.getByRole("button", { name: /Below/ }));
		expect(below).toHaveBeenCalledOnce();
	});
});
