import { useT, type TranslationKey } from "../i18n";
import { toast } from "../toast";
import { copyTextToClipboard } from "../utils/clipboard";
import type { TouchLink, TouchLinkKind } from "../terminal-touch-links";
import BottomSheet from "./BottomSheet";

const COPY: Record<TouchLinkKind, { title: TranslationKey; open: TranslationKey; copy: TranslationKey; copied: TranslationKey }> = {
	web: { title: "terminal.linkSheetTitleWeb", open: "terminal.linkSheetOpenWeb", copy: "terminal.linkSheetCopyLink", copied: "terminal.linkSheetLinkCopied" },
	file: { title: "terminal.linkSheetTitleFile", open: "terminal.linkSheetOpenFile", copy: "terminal.linkSheetCopyPath", copied: "terminal.filePreviewCopied" },
	app: { title: "terminal.linkSheetTitleApp", open: "terminal.linkSheetOpenApp", copy: "terminal.linkSheetCopyLink", copied: "terminal.linkSheetLinkCopied" },
};

interface TerminalLinkSheetProps {
	link: TouchLink | null;
	onClose: () => void;
	taskId?: string;
}

/**
 * The touch form of Cmd/Ctrl+Click on a terminal link: the full destination
 * (an OSC 8 label can say anything, so the target is what gets shown) and an
 * explicit Open / Copy. Open runs inside the button's own tap, which is the
 * user gesture mobile browsers require before `window.open`.
 */
export default function TerminalLinkSheet({ link, onClose, taskId }: TerminalLinkSheetProps) {
	const t = useT();
	if (!link) return null;
	const copy = COPY[link.kind];

	function open() {
		link!.open();
		onClose();
	}

	async function copyTarget() {
		const ok = await copyTextToClipboard(link!.target);
		if (ok) {
			toast.success(t(copy.copied), { taskId, source: "terminal" });
			onClose();
		} else {
			toast.error(t("terminal.linkSheetCopyFailed"), { taskId, source: "terminal" });
		}
	}

	return (
		<BottomSheet open onClose={onClose} title={t(copy.title)} testId="terminal-link-sheet">
			<p
				className="mb-3 select-text break-all rounded-lg bg-base px-3 py-2 font-mono text-sm text-fg"
				data-testid="terminal-link-sheet-target"
			>
				{link.target}
			</p>
			<div className="flex flex-col gap-2">
				<button
					type="button"
					onClick={open}
					className="min-h-[44px] w-full rounded-xl bg-accent-fill px-4 py-3 text-sm font-semibold text-white transition-[background-color,transform] hover:bg-accent-fill-hover active:scale-[0.96]"
				>
					{t(copy.open)}
				</button>
				<button
					type="button"
					onClick={() => void copyTarget()}
					className="min-h-[44px] w-full rounded-xl bg-elevated px-4 py-3 text-sm font-medium text-fg-2 transition-[background-color,color,transform] hover:bg-elevated-hover hover:text-fg active:scale-[0.96]"
				>
					{t(copy.copy)}
				</button>
			</div>
		</BottomSheet>
	);
}
