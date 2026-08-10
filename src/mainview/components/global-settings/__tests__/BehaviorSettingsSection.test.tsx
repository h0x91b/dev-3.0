import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GlobalSettings } from "../../../../shared/types";
import { I18nProvider, type TFunction } from "../../../i18n";
import BehaviorSettingsSection from "../BehaviorSettingsSection";

// Stub translator: keys through, except the built-in prompt whose real text is
// what "reset to default" has to restore.
const BUILTIN_PROMPT = "Review the code changes on this branch.";
const t = ((key: string) =>
	key === "createTask.reviewPrompt" ? BUILTIN_PROMPT : key) as unknown as TFunction;

function renderSection(settings: Partial<GlobalSettings> = {}) {
	const onReviewModePromptChange = vi.fn();
	render(
		<I18nProvider>
			<BehaviorSettingsSection
				t={t}
				globalSettings={{ taskDropPosition: "top", ...settings } as GlobalSettings}
				tipsResetDone={false}
				onDefaultDiffViewModeChange={vi.fn()}
				onSoundToggle={vi.fn()}
				onWatchByDefaultToggle={vi.fn()}
				onSuggestCompletingTasksAfterMergeToggle={vi.fn()}
				onFocusModeToggle={vi.fn()}
				onTaskDropPositionChange={vi.fn()}
				onTaskOpenModeChange={vi.fn()}
				onTipsDisabledToggle={vi.fn()}
				onTipsReset={vi.fn()}
				onReviewModePromptChange={onReviewModePromptChange}
			/>
		</I18nProvider>,
	);
	const textarea = screen.getByLabelText("settings.reviewModePrompt") as HTMLTextAreaElement;
	const reset = screen.getByRole("button", { name: "settings.reviewModePromptReset" });
	return { textarea, reset, onReviewModePromptChange };
}

describe("BehaviorSettingsSection — review prompt", () => {
	it("prefills the built-in prompt and keeps reset disabled while untouched", () => {
		const { textarea, reset } = renderSection();
		expect(textarea.value).toBe(BUILTIN_PROMPT);
		expect(reset).toBeDisabled();
		expect(screen.queryByText("settings.reviewModePromptCustom")).not.toBeInTheDocument();
	});

	it("shows a stored custom prompt", () => {
		const { textarea, reset } = renderSection({ reviewModePrompt: "Only blockers." });
		expect(textarea.value).toBe("Only blockers.");
		expect(reset).toBeEnabled();
		expect(screen.getByText("settings.reviewModePromptCustom")).toBeInTheDocument();
	});

	it("persists an edit on blur", async () => {
		const { textarea, onReviewModePromptChange } = renderSection();
		await userEvent.clear(textarea);
		await userEvent.type(textarea, "Only blockers.");
		expect(onReviewModePromptChange).not.toHaveBeenCalled();
		await userEvent.tab();
		expect(onReviewModePromptChange).toHaveBeenCalledWith("Only blockers.");
	});

	it("stores nothing when the field is left equal to the built-in prompt", async () => {
		const { textarea, onReviewModePromptChange } = renderSection({ reviewModePrompt: "Only blockers." });
		await userEvent.clear(textarea);
		await userEvent.type(textarea, BUILTIN_PROMPT);
		await userEvent.tab();
		expect(onReviewModePromptChange).toHaveBeenCalledWith("");
	});

	it("restores the built-in prompt and clears the stored value on reset", async () => {
		const { textarea, reset, onReviewModePromptChange } = renderSection({ reviewModePrompt: "Only blockers." });
		await userEvent.click(reset);
		expect(textarea.value).toBe(BUILTIN_PROMPT);
		expect(onReviewModePromptChange).toHaveBeenCalledWith("");
	});
});
