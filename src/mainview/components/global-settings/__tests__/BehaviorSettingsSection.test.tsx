import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GlobalSettings } from "../../../../shared/types";
import { DEFAULT_PR_REVIEW_PROMPT } from "../../../../shared/types";
import { I18nProvider, type TFunction } from "../../../i18n";
import BehaviorSettingsSection from "../BehaviorSettingsSection";

// Stub translator: keys straight through. The built-in review prompt is no longer
// a translation — one English constant serves both the create flow and the CLI —
// so "reset to default" has to restore exactly that constant.
const BUILTIN_PROMPT = DEFAULT_PR_REVIEW_PROMPT;
const t = ((key: string) => key) as unknown as TFunction;

function renderSection(
	settings: Partial<GlobalSettings> = {},
	{ prOriginTaskLinkSupported = true }: { prOriginTaskLinkSupported?: boolean } = {},
) {
	const onReviewModePromptChange = vi.fn();
	const onPrOriginTaskLinkToggle = vi.fn();
	render(
		<I18nProvider>
			<BehaviorSettingsSection
				t={t}
				globalSettings={{ taskSortOrder: "oldest-first", ...settings } as GlobalSettings}
				tipsResetDone={false}
				onDefaultDiffViewModeChange={vi.fn()}
				onSoundToggle={vi.fn()}
				onWatchByDefaultToggle={vi.fn()}
				onSuggestCompletingTasksAfterMergeToggle={vi.fn()}
				onPrOriginTaskLinkToggle={onPrOriginTaskLinkToggle}
				prOriginTaskLinkSupported={prOriginTaskLinkSupported}
				onFocusModeToggle={vi.fn()}
				onTaskSortOrderChange={vi.fn()}
				onTaskOpenModeChange={vi.fn()}
				onTipsDisabledToggle={vi.fn()}
				onTipsReset={vi.fn()}
				onReviewModePromptChange={onReviewModePromptChange}
				onCoordinatorPromptChange={vi.fn()}
			/>
		</I18nProvider>,
	);
	const textarea = screen.getByLabelText("settings.reviewModePrompt") as HTMLTextAreaElement;
	const reset = screen.getByRole("button", { name: "settings.reviewModePromptReset" });
	return { textarea, reset, onReviewModePromptChange, onPrOriginTaskLinkToggle };
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

describe("BehaviorSettingsSection — PR origin-task link toggle", () => {
	function prSwitch() {
		return screen.getByRole("switch", { name: "settings.prOriginTaskLink" });
	}

	it("is on by default and turning it off reports false", async () => {
		const { onPrOriginTaskLinkToggle } = renderSection();
		expect(prSwitch()).toHaveAttribute("aria-checked", "true");
		await userEvent.click(prSwitch());
		expect(onPrOriginTaskLinkToggle).toHaveBeenCalledWith(false);
	});

	it("reflects a stored opt-out and turning it on reports true", async () => {
		const { onPrOriginTaskLinkToggle } = renderSection({ prOriginTaskLink: false });
		expect(prSwitch()).toHaveAttribute("aria-checked", "false");
		await userEvent.click(prSwitch());
		expect(onPrOriginTaskLinkToggle).toHaveBeenCalledWith(true);
	});

	// Windows: the host registers no dev3:// handler, so the control reads Off and
	// inert — while the stored `true` on disk stays exactly as the user left it.
	it("reads off, inert and explained when the host cannot open dev3:// links", async () => {
		const { onPrOriginTaskLinkToggle } = renderSection(
			{ prOriginTaskLink: true },
			{ prOriginTaskLinkSupported: false },
		);
		expect(prSwitch()).toHaveAttribute("aria-checked", "false");
		expect(screen.getByTestId("pr-origin-task-link-unsupported")).toHaveTextContent(
			"settings.prOriginTaskLinkUnsupported",
		);
		await userEvent.click(prSwitch());
		expect(onPrOriginTaskLinkToggle).not.toHaveBeenCalled();
	});
});
