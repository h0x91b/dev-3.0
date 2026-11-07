import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GlobalSettings } from "../../../../shared/types";
import { I18nProvider, type TFunction } from "../../../i18n";
import NotificationSettingsSection from "../NotificationSettingsSection";

vi.mock("../BrowserNotificationsSetting", () => ({
	default: () => <div data-testid="browser-notification-settings" />,
}));

const t = Object.assign((key: string) => key, {
	plural: (key: string, count: number) => `${key}|${count}`,
}) as unknown as TFunction;

function renderSection(settings: Partial<GlobalSettings> = {}) {
	const onSoundToggle = vi.fn();
	const onQuestionsSoundToggle = vi.fn();
	const onReviewSoundToggle = vi.fn();
	const onFocusModeToggle = vi.fn();
	const onWatchByDefaultToggle = vi.fn();
	render(
		<I18nProvider>
			<NotificationSettingsSection
				t={t}
				globalSettings={{ taskSortOrder: "oldest-first", ...settings } as GlobalSettings}
				onSoundToggle={onSoundToggle}
				onQuestionsSoundToggle={onQuestionsSoundToggle}
				onReviewSoundToggle={onReviewSoundToggle}
				onFocusModeToggle={onFocusModeToggle}
				onWatchByDefaultToggle={onWatchByDefaultToggle}
			/>
		</I18nProvider>,
	);
	return { onSoundToggle, onQuestionsSoundToggle, onReviewSoundToggle, onFocusModeToggle, onWatchByDefaultToggle };
}

describe("NotificationSettingsSection", () => {
	it("owns every notification preference", () => {
		renderSection();

		expect(screen.getByText("settings.categoryNotifications")).toBeInTheDocument();
		expect(document.querySelector('[data-settings-entry="task-complete-sound"]')).not.toBeNull();
		expect(document.querySelector('[data-settings-entry="task-questions-sound"]')).not.toBeNull();
		expect(document.querySelector('[data-settings-entry="task-review-sound"]')).not.toBeNull();
		expect(document.querySelector('[data-settings-entry="focus-mode"]')).not.toBeNull();
		expect(document.querySelector('[data-settings-entry="watch-by-default"]')).not.toBeNull();
		expect(screen.getByTestId("browser-notification-settings")).toBeInTheDocument();
	});

	it("persists the three global notification toggles", async () => {
		const callbacks = renderSection({
			playSoundOnTaskComplete: false,
			focusMode: false,
			watchByDefault: true,
		});

		await userEvent.click(screen.getByRole("switch", { name: "settings.taskCompleteSound" }));
		await userEvent.click(screen.getByRole("switch", { name: "settings.focusMode" }));
		await userEvent.click(screen.getByRole("switch", { name: "settings.watchByDefault" }));

		expect(callbacks.onSoundToggle).toHaveBeenCalledWith(true);
		expect(callbacks.onFocusModeToggle).toHaveBeenCalledWith(true);
		expect(callbacks.onWatchByDefaultToggle).toHaveBeenCalledWith(false);
	});

	it("shows both needs-you chimes off by default and turns each on separately", async () => {
		const callbacks = renderSection();
		const questions = screen.getByRole("switch", { name: "settings.taskQuestionsSound" });
		const review = screen.getByRole("switch", { name: "settings.taskReviewSound" });

		expect(questions).toHaveAttribute("aria-checked", "false");
		expect(review).toHaveAttribute("aria-checked", "false");
		await userEvent.click(questions);

		expect(callbacks.onQuestionsSoundToggle).toHaveBeenCalledWith(true);
		expect(callbacks.onReviewSoundToggle).not.toHaveBeenCalled();
		expect(callbacks.onSoundToggle).not.toHaveBeenCalled();
	});

	it("turns a stored Your Review chime off without touching Has Questions", async () => {
		const callbacks = renderSection({ playSoundOnTaskReview: true });
		const review = screen.getByRole("switch", { name: "settings.taskReviewSound" });

		expect(review).toHaveAttribute("aria-checked", "true");
		await userEvent.click(review);

		expect(callbacks.onReviewSoundToggle).toHaveBeenCalledWith(false);
		expect(callbacks.onQuestionsSoundToggle).not.toHaveBeenCalled();
	});
});
