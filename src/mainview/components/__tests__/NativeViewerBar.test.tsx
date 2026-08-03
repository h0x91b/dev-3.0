/**
 * The native terminal's read-only strip (seq 1300).
 *
 * The point of the strip is that a read-only terminal must never be mistakable
 * for a hung one — so it renders for an observer, offers the takeover, reacts to
 * a refused keystroke, and disappears entirely for the writer (and therefore for
 * every tmux terminal, which never reports a role at all).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NativeViewerBar from "../NativeViewerBar";
import { I18nProvider } from "../../i18n";

afterEach(cleanup);

function renderBar(props: Partial<React.ComponentProps<typeof NativeViewerBar>> = {}) {
	const onTakeControl = vi.fn();
	const result = render(
		<I18nProvider>
			<NativeViewerBar role="observer" refusedAt={0} onTakeControl={onTakeControl} {...props} />
		</I18nProvider>,
	);
	return { ...result, onTakeControl };
}

describe("NativeViewerBar", () => {
	it("renders nothing for the writer — the normal case gets no chrome", () => {
		const { container } = renderBar({ role: "writer" });

		expect(container).toBeEmptyDOMElement();
	});

	it("tells an observer the terminal is read-only", () => {
		renderBar();

		expect(screen.getByRole("status")).toHaveTextContent(/read-only/i);
		expect(screen.getByRole("button", { name: /take control/i })).toBeInTheDocument();
	});

	it("asks for the writer lease when the user takes control", async () => {
		const { onTakeControl } = renderBar();

		await userEvent.click(screen.getByRole("button", { name: /take control/i }));

		expect(onTakeControl).toHaveBeenCalledTimes(1);
	});

	it("flashes a refusal, then settles back to the plain read-only notice", () => {
		vi.useFakeTimers();
		try {
			const { rerender, onTakeControl } = renderBar();
			rerender(
				<I18nProvider>
					<NativeViewerBar role="observer" refusedAt={1234} onTakeControl={onTakeControl} />
				</I18nProvider>,
			);

			expect(screen.getByRole("status")).toHaveTextContent(/take control to type/i);

			act(() => {
				vi.advanceTimersByTime(2000);
			});
			expect(screen.getByRole("status")).toHaveTextContent(/another viewer is typing/i);
		} finally {
			vi.useRealTimers();
		}
	});

	// Once Take control can actually transfer a lease between dev3 processes,
	// the only refusal left is one clicking cannot fix — so it must not read like the
	// retryable one, and the strip must say what to do instead.
	it("distinguishes a host that cannot transfer from a retryable refusal", () => {
		vi.useFakeTimers();
		try {
			const { onTakeControl } = renderBar({ refusedAt: 99, refusedReason: "host-too-old" });

			const status = screen.getByRole("status");
			expect(status).toHaveTextContent(/too old/i);
			expect(status).not.toHaveTextContent(/take control to type/i);
			// The strip truncates, so the actionable sentence rides the button's tooltip.
			expect(screen.getByRole("button", { name: /take control/i })).toBeInTheDocument();

			// GUIDANCE, not an event: clicking again cannot fix an old host, so the sentence
			// must NOT time out into the generic read-only line the way a flash does.
			act(() => {
				vi.advanceTimersByTime(10_000);
			});
			expect(screen.getByRole("status")).toHaveTextContent(/too old/i);
			// The slot can still free up when the other window leaves, so the gesture stays
			// available — disabling it would strand the one recovery path that does work.
			expect(screen.getByRole("button", { name: /take control/i })).toBeEnabled();
			expect(onTakeControl).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("retires the old-host guidance once the host verdict changes", () => {
		const { rerender, onTakeControl } = renderBar({ refusedAt: 99, refusedReason: "host-too-old" });
		expect(screen.getByRole("status")).toHaveTextContent(/too old/i);

		rerender(
			<I18nProvider>
				<NativeViewerBar role="observer" refusedAt={99} writerAttached={false} onTakeControl={onTakeControl} />
			</I18nProvider>,
		);

		expect(screen.getByRole("status")).not.toHaveTextContent(/too old/i);
	});

	it("says the host never answered, without guessing why", () => {
		renderBar({ refusedAt: 99, refusedReason: "transfer-failed" });

		const status = screen.getByRole("status");
		expect(status).toHaveTextContent(/no answer from the terminal/i);
		expect(status).not.toHaveTextContent(/too old/i);
	});
});
