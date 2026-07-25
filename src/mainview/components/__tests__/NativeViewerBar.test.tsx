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
});
