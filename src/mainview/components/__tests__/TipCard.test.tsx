import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import TipCard from "../TipCard";
import { I18nProvider } from "../../i18n";
import { ALL_TIPS } from "../../tips";
import type { TipState } from "../../../shared/types";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			updateTipState: vi.fn((params: Partial<TipState>) =>
				Promise.resolve({ snoozedUntil: 0, seen: {}, rotationIndex: 0, ...params } as TipState),
			),
		},
	},
}));

const tip = ALL_TIPS.find((t) => t.id === "terminal-select-copies")!;
const tipState: TipState = { snoozedUntil: 0, seen: {}, rotationIndex: 3 };

function renderCard(onChanged = vi.fn()) {
	render(
		<I18nProvider>
			<TipCard tip={tip} tipState={tipState} onChanged={onChanged} />
		</I18nProvider>,
	);
	return onChanged;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("TipCard", () => {
	it("rotates when the progress-bar animation ends (advancing rotationIndex, seen[tipId])", async () => {
		const { api } = await import("../../rpc");
		const onChanged = renderCard();
		const bar = screen.getByTestId("tip-progress");

		fireEvent.animationEnd(bar, { animationName: "tip-progress" });

		await waitFor(() => expect(api.request.updateTipState).toHaveBeenCalledTimes(1));
		const payload = vi.mocked(api.request.updateTipState).mock.calls[0][0];
		expect(payload.rotationIndex).toBe(4);
		expect(Object.keys(payload.seen ?? {})).toEqual([tip.id]);
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
	});

	it("ignores animationend events from other animations", async () => {
		const { api } = await import("../../rpc");
		renderCard();
		const bar = screen.getByTestId("tip-progress");

		fireEvent.animationEnd(bar, { animationName: "some-other-animation" });

		// Give any erroneous async write a chance to fire.
		await Promise.resolve();
		expect(api.request.updateTipState).not.toHaveBeenCalled();
	});

	it("Next tip advances the rotation", async () => {
		const { api } = await import("../../rpc");
		renderCard();

		await userEvent.click(screen.getByText(/Next tip/i));

		await waitFor(() => expect(api.request.updateTipState).toHaveBeenCalledTimes(1));
		expect(vi.mocked(api.request.updateTipState).mock.calls[0][0].rotationIndex).toBe(4);
	});

	it("pauses the progress bar while the card is hovered", async () => {
		renderCard();
		const bar = screen.getByTestId("tip-progress");
		const card = bar.closest("div.relative") as HTMLElement;

		expect(bar.style.animationPlayState).toBe("running");
		fireEvent.mouseEnter(card);
		expect(bar.style.animationPlayState).toBe("paused");
		fireEvent.mouseLeave(card);
		expect(bar.style.animationPlayState).toBe("running");
	});
});
