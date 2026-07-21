import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToastSuppressed, ToastHost, toast } from "../toast";

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
