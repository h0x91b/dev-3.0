import { useState } from "react";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { useFocusTrap } from "../utils/useFocusTrap";
import { useT } from "../i18n";
import { cleanSavedViewName, SAVED_VIEW_NAME_MAX } from "../../shared/board-view-state";

/** Names a new saved view or renames one. Names are unique per board, ignoring case. */
export function SavedViewNameModal({ mode, initialName, takenNames, onSubmit, onClose }: {
	mode: "new" | "rename";
	initialName: string;
	/** The board's other saved view names. */
	takenNames: readonly string[];
	onSubmit: (name: string) => void;
	onClose: () => void;
}) {
	const t = useT();
	const trapRef = useFocusTrap<HTMLDivElement>();
	const [name, setName] = useState(initialName);
	const [attempted, setAttempted] = useState(false);
	useEscapeKey(onClose);

	const clean = cleanSavedViewName(name);
	const taken = clean !== "" && takenNames.some((other) => other.toLowerCase() === clean.toLowerCase());
	const empty = clean === "";
	const canSubmit = !empty && !taken;
	// Validated on submit, so Save stays in the tab order and says why it did nothing.
	const error = taken ? "boardView.saved.nameTaken" : attempted && empty ? "boardView.saved.nameEmpty" : null;

	function submit() {
		setAttempted(true);
		if (!canSubmit) return;
		onSubmit(clean);
		onClose();
	}

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				ref={trapRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="saved-view-name-title"
				tabIndex={-1}
				className="bg-overlay border border-edge rounded-2xl shadow-2xl w-[26rem] max-w-[92vw] p-6 space-y-4 outline-none"
				data-testid="saved-view-name-dialog"
			>
				<h2 id="saved-view-name-title" className="text-fg text-lg font-semibold">
					{t(mode === "new" ? "boardView.saved.newTitle" : "boardView.saved.renameTitle")}
				</h2>
				<form
					className="space-y-1.5"
					onSubmit={(e) => {
						e.preventDefault();
						submit();
					}}
				>
					<label htmlFor="saved-view-name-input" className="block text-xs text-fg-3">
						{t("boardView.saved.nameLabel")}
					</label>
					<input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						id="saved-view-name-input"
						placeholder={t("boardView.saved.namePlaceholder")}
						aria-invalid={error !== null}
						aria-describedby="saved-view-name-hint"
						maxLength={SAVED_VIEW_NAME_MAX}
						autoFocus
						className="w-full bg-elevated border border-edge rounded-lg px-3 py-2 text-base sm:text-sm text-fg placeholder-fg-muted outline-none focus:border-accent/50 transition-colors"
						data-testid="saved-view-name-input"
					/>
					<p id="saved-view-name-hint" className={`text-xs ${error ? "text-danger" : "text-fg-3"}`}>
						{t(error ?? "boardView.saved.nameHint")}
					</p>
				</form>
				<div className="flex justify-end gap-2">
					<button
						type="button"
						onClick={onClose}
						className="px-3 py-1.5 text-sm rounded-lg text-fg-2 hover:text-fg hover:bg-overlay-hover transition-colors"
					>
						{t("boardView.saved.cancel")}
					</button>
					<button
						type="button"
						onClick={submit}
						className="px-3 py-1.5 text-sm font-semibold rounded-lg bg-accent-fill text-white hover:bg-accent-fill-hover transition-colors"
						data-testid="saved-view-name-submit"
					>
						{t(mode === "new" ? "boardView.saved.saveButton" : "boardView.saved.renameButton")}
					</button>
				</div>
			</div>
		</div>
	);
}
