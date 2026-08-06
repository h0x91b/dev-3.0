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
const linkedTip = ALL_TIPS.find((t) => t.id === "focus-mode-mutes-pings")!;
const tipState: TipState = { snoozedUntil: 0, seen: {}, rotationIndex: 3 };

function renderCard(onChanged = vi.fn(), which = tip) {
	render(
		<I18nProvider>
			<TipCard tip={which} tipState={tipState} onChanged={onChanged} />
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

	it("deep-links to the setting instead of naming a path, and only when the tip has one", async () => {
		const { OPEN_SETTINGS_SECTION_EVENT } = await import("../../state");
		const onOpen = vi.fn();
		window.addEventListener(OPEN_SETTINGS_SECTION_EVENT, onOpen);

		renderCard(vi.fn(), linkedTip);
		await userEvent.click(screen.getByText(/Open the setting/i));

		expect(onOpen).toHaveBeenCalledTimes(1);
		expect((onOpen.mock.calls[0][0] as CustomEvent).detail).toBe(linkedTip.settingsSection);
		window.removeEventListener(OPEN_SETTINGS_SECTION_EVENT, onOpen);
	});

	it("omits the settings link for a tip that has no destination", () => {
		renderCard();
		expect(screen.queryByText(/Open the setting/i)).toBeNull();
	});

	// A Global Settings path in prose rots the moment a category is renamed —
	// three tips shipped pointing at a "Behavior" category that no longer exists.
	// Declare the destination as data (Tip.settingsSection) and let TipCard link it.
	it("no tip or tooltip spells out a Global Settings path", async () => {
		const en = (await import("../../i18n/translations/en")).default;
		const offenders = Object.entries(en)
			.filter(([key]) => key.startsWith("tip.") || key.startsWith("tooltip."))
			.filter(([, value]) => typeof value === "string" && /(?<!Project )Settings\s*→/.test(value))
			.map(([key]) => key);
		expect(offenders).toEqual([]);
	});

	// Project Settings is a per-project surface with no global deep link, so its
	// path may stay in prose — but the tab it names still has to exist.
	it("every settings path left in prose names a real destination", async () => {
		const en = (await import("../../i18n/translations/en")).default;
		const { SETTINGS_CATEGORIES } = await import("../../settings-registry");
		const known = new Set([
			...SETTINGS_CATEGORIES.map((c) => en[c.labelKey] as string),
			// Project Settings tabs (ProjectSettings.tsx).
			"Automations",
			"Board",
			"Project",
			"Worktree",
		]);
		const named = Object.entries(en)
			.filter(([key]) => key.startsWith("tip.") || key.startsWith("tooltip."))
			.flatMap(([key, value]) =>
				typeof value === "string"
					? [...value.matchAll(/Settings\s*→\s*([^→,.:(]+)/g)].map((m) => [key, m[1].trim()] as const)
					: [],
			);
		expect(named.filter(([, dest]) => !known.has(dest))).toEqual([]);
	});

	it("renders the disk-reclaim tip's translated title and body", () => {
		renderCard(vi.fn(), ALL_TIPS.find((t) => t.id === "cli-doctor-worktrees")!);
		expect(screen.getByText("Reclaim gigabytes of worktrees")).toBeTruthy();
		expect(screen.getByText(/dev3 doctor --worktrees/)).toBeTruthy();
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
