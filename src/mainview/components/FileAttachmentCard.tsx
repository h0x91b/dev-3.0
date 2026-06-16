import { api } from "../rpc";
import { useT } from "../i18n";

const FILE_DOC_ICON = "\u{F09ED}"; // nf-md-note_text_outline

interface FileAttachmentCardProps {
	path: string;
	onRemove?: () => void;
}

export function FileAttachmentCard({ path, onRemove }: FileAttachmentCardProps) {
	const t = useT();
	const filename = path.split("/").pop() ?? path;
	const ext = filename.includes(".") ? filename.split(".").pop()!.toUpperCase() : "FILE";

	return (
		<div className="relative flex-shrink-0 group">
			<button
				onClick={() => { api.request.openImageFile({ path }).catch(() => {}); }}
				className="flex flex-col items-center justify-center gap-1 w-[6.25rem] h-[5rem] rounded-lg bg-elevated border border-edge group-hover:border-accent/50 transition-colors cursor-pointer px-1.5"
				title={t("attachments.openFile", { name: filename })}
			>
				<span
					className="text-[1.5rem] leading-none text-fg-3"
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{FILE_DOC_ICON}
				</span>
				<span className="text-[0.5625rem] text-fg-muted truncate max-w-[5.5rem]" title={filename}>
					{filename}
				</span>
				<span className="text-[0.5rem] text-fg-muted/70 uppercase tracking-wide">{ext}</span>
			</button>
			{onRemove && (
				<button
					onClick={(e) => { e.stopPropagation(); onRemove(); }}
					className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-danger text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
					title={t("attachments.removeFile")}
				>
					<svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			)}
		</div>
	);
}
