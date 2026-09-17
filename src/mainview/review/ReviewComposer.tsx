import { useState } from "react";
import { useT } from "../i18n";

const ICON = "'JetBrainsMono Nerd Font Mono'";

interface ReviewComposerProps {
	/** Where the comment lands, already worded for the surface: `src/a.ts · New line 4`, `Overview › Agent success`. */
	anchorLabel: string;
	onCancel: () => void;
	onSubmit: (body: string) => void;
	onSubmitAndSend: (body: string) => void;
}

/**
 * The one composer every review surface opens. Three actions, budgeted: Cancel,
 * `Send now` (the one-shot lane — parked in the review AND shipped to the agent
 * in one click) and `Add comment` (parked for the batch).
 */
export function ReviewComposer({ anchorLabel, onCancel, onSubmit, onSubmitAndSend }: ReviewComposerProps) {
	const t = useT();
	const [value, setValue] = useState("");
	const trimmedValue = value.trim();

	return (
		<form
			className="dev3-inline-comment dev3-inline-comment--composer border-t border-edge bg-base/90 px-4 py-3 space-y-3"
			onSubmit={(event) => {
				event.preventDefault();
				if (!trimmedValue) return;
				onSubmit(trimmedValue);
				setValue("");
			}}
		>
			<div className="space-y-1">
				<div className="dev3-inline-comment__title text-xs font-semibold text-fg">
					{t("infoPanel.diffCommentAdd")}
				</div>
				<div className="dev3-inline-comment__meta text-micro text-fg-3">{anchorLabel}</div>
			</div>
			<textarea
				value={value}
				onChange={(event) => setValue(event.target.value)}
				placeholder={t("infoPanel.diffCommentPlaceholder")}
				rows={3}
				autoFocus
				className="dev3-inline-comment__textarea w-full resize-y rounded-lg border border-edge bg-raised px-3 py-2 text-sm text-fg outline-none transition-colors placeholder:text-fg-muted focus:border-edge-active focus:bg-elevated"
			/>
			<div className="dev3-inline-comment__actions flex items-center justify-end gap-2">
				<button
					type="button"
					onClick={onCancel}
					className="dev3-inline-comment__button dev3-inline-comment__button--secondary inline-flex h-8 items-center justify-center rounded-md border border-edge bg-base px-3 text-xs font-semibold text-fg-2 transition-colors hover:bg-elevated-hover"
				>
					{t("infoPanel.diffCommentCancel")}
				</button>
				<button
					type="button"
					onClick={() => {
						if (!trimmedValue) return;
						onSubmitAndSend(trimmedValue);
						setValue("");
					}}
					disabled={!trimmedValue}
					data-testid="inline-comment-composer-send"
					title={t("infoPanel.diffCommentSubmitSendTooltip")}
					className="dev3-inline-comment__button dev3-inline-comment__button--secondary inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-edge bg-base px-3 text-xs font-semibold text-fg-2 transition-colors hover:bg-elevated-hover disabled:cursor-not-allowed disabled:text-fg-muted"
				>
					<span aria-hidden="true" className="text-sm-plus leading-none" style={{ fontFamily: ICON }}>{""}</span>
					<span>{t("infoPanel.diffCommentSubmitSend")}</span>
				</button>
				<button
					type="submit"
					disabled={!trimmedValue}
					className="dev3-inline-comment__button dev3-inline-comment__button--primary inline-flex h-8 items-center justify-center rounded-md border border-accent bg-accent-fill px-3 text-xs font-semibold text-white transition-colors hover:bg-accent-fill-hover disabled:cursor-not-allowed disabled:border-edge disabled:bg-base disabled:text-fg-muted"
				>
					{t("infoPanel.diffCommentSubmit")}
				</button>
			</div>
		</form>
	);
}
