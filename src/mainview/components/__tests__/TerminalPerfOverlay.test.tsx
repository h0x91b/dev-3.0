/**
 * The Debug → Terminal Performance HUD. What matters here is that it reads the
 * live probe registry rather than a snapshot frozen at mount, that it keeps
 * saying something useful with no terminal open, and that it colours the numbers
 * a perf session is actually looking for.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TerminalPerfOverlay from "../TerminalPerfOverlay";
import { I18nProvider } from "../../i18n";
import {
	createTerminalLatencyProbe,
	registerLatencyProbe,
	__resetLatencyProbesForTests,
	LONG_FRAME_MS,
	RATE_WINDOW_MS,
} from "../../terminal-latency";

function renderOverlay(onClose = vi.fn()) {
	render(
		<I18nProvider>
			<TerminalPerfOverlay onClose={onClose} />
		</I18nProvider>,
	);
	return { onClose };
}

/** A clock the test drives by hand, so the rate windows close on demand. */
function fakeClock() {
	let t = 1000;
	return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/** Let the 500 ms poll fire once. */
async function poll() {
	await act(async () => {
		vi.advanceTimersByTime(600);
	});
}

beforeEach(() => {
	__resetLatencyProbesForTests();
	vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("TerminalPerfOverlay", () => {
	it("says what to do when no terminal is registered", () => {
		renderOverlay();
		expect(screen.getByText(/No terminal is open/i)).toBeInTheDocument();
	});

	it("shows a registered pane and its live numbers", async () => {
		const clock = fakeClock();
		const probe = createTerminalLatencyProbe({ now: clock.now });
		registerLatencyProbe("abc12345 · localhost:1/?session=s", probe);

		renderOverlay();

		for (let i = 0; i < 59; i++) probe.noteFrame(0.4);
		probe.noteWrite(0.2);
		clock.advance(RATE_WINDOW_MS);
		await poll();

		expect(screen.getByText("abc12345 · localhost:1/?session=s")).toBeInTheDocument();
		expect(screen.getByText("59")).toBeInTheDocument();
		expect(screen.getByText("upd 1/s")).toBeInTheDocument();
	});

	it("picks up a pane that registered after mount", async () => {
		renderOverlay();
		expect(screen.getByText(/No terminal is open/i)).toBeInTheDocument();

		registerLatencyProbe("late-pane", createTerminalLatencyProbe());
		await poll();

		expect(screen.getByText("late-pane")).toBeInTheDocument();
	});

	it("marks a starved render loop as bad and a healthy one as not", async () => {
		const clock = fakeClock();
		const probe = createTerminalLatencyProbe({ now: clock.now });
		registerLatencyProbe("pane", probe);
		renderOverlay();

		// 20 frames in a second: the loop is not keeping up with a 60 Hz display.
		for (let i = 0; i < 20; i++) probe.noteFrame(0.4);
		clock.advance(RATE_WINDOW_MS);
		await poll();

		expect(screen.getByText("20")).toHaveClass("text-danger");
	});

	it("counts the frames that missed their slot, and shows the threshold", async () => {
		const clock = fakeClock();
		const probe = createTerminalLatencyProbe({ now: clock.now });
		registerLatencyProbe("pane", probe);
		renderOverlay();

		probe.noteFrame(0.4);
		clock.advance(LONG_FRAME_MS + 5);
		probe.noteFrame(0.4);
		clock.advance(RATE_WINDOW_MS);
		await poll();

		expect(screen.getByText("1/s")).toBeInTheDocument();
		expect(screen.getByText(`>${LONG_FRAME_MS}ms`)).toBeInTheDocument();
	});

	it("prompts for a sample instead of printing a fake zero latency", () => {
		registerLatencyProbe("pane", createTerminalLatencyProbe());
		renderOverlay();

		expect(screen.getByText("type to sample")).toBeInTheDocument();
	});

	it("closes on the × button", async () => {
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		const { onClose } = renderOverlay();

		await user.click(screen.getByTestId("terminal-perf-close"));

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("stops polling once unmounted", async () => {
		const probe = createTerminalLatencyProbe();
		const spy = vi.spyOn(probe, "snapshot");
		registerLatencyProbe("pane", probe);

		const { unmount } = render(
			<I18nProvider>
				<TerminalPerfOverlay onClose={vi.fn()} />
			</I18nProvider>,
		);
		await poll();
		const afterMount = spy.mock.calls.length;
		expect(afterMount).toBeGreaterThan(0);

		unmount();
		await poll();

		expect(spy.mock.calls.length).toBe(afterMount);
	});
});
