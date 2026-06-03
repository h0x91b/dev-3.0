import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastHost, toast } from "../toast";

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

	it("auto-dismisses after the given duration", () => {
		vi.useFakeTimers();
		try {
			render(<ToastHost />);
			act(() => {
				toast.error("Temporary", { durationMs: 5000 });
			});
			expect(screen.getByText("Temporary")).toBeInTheDocument();
			act(() => {
				vi.advanceTimersByTime(5000);
			});
			expect(screen.queryByText("Temporary")).not.toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not throw when no host is mounted", () => {
		expect(() => toast.error("orphan")).not.toThrow();
	});
});
