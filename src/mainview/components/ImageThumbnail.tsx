import { useT } from "../i18n";
import { useImageDataUrl } from "../utils/useImageDataUrl";

interface ImageThumbnailProps {
	path: string;
	onClick: () => void;
	onRemove?: () => void;
}

export function ImageThumbnail({ path, onClick, onRemove }: ImageThumbnailProps) {
	const t = useT();
	const { dataUrl, loading, error } = useImageDataUrl(path);

	const filename = path.split("/").pop() ?? path;

	if (loading) {
		return (
			<div className="flex-shrink-0 w-[6.25rem] h-[5rem] rounded-lg bg-elevated animate-pulse flex items-center justify-center">
				<span className="text-dense text-fg-muted">{t("images.loading")}</span>
			</div>
		);
	}

	if (error || !dataUrl) {
		return (
			<div className="relative flex-shrink-0 w-[6.25rem] h-[5rem] rounded-lg bg-elevated border border-danger/30 flex items-center justify-center group">
				<span className="text-dense text-danger">{t("images.loadFailed")}</span>
				{onRemove && (
					<button
						onClick={(e) => { e.stopPropagation(); onRemove(); }}
						className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-danger-fill text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
						title={t("images.remove")}
					>
						<svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				)}
			</div>
		);
	}

	return (
		<div className="relative flex-shrink-0 group">
			<button
				onClick={onClick}
				className="flex flex-col items-center gap-0.5 cursor-pointer"
				title={filename}
			>
				<img
					src={dataUrl}
					alt={filename}
					className="max-h-[5rem] max-w-[7.5rem] rounded-lg border border-edge group-hover:border-accent/50 transition-colors object-contain"
				/>
				<span className="text-nano text-fg-muted truncate max-w-[7.5rem]">{filename}</span>
			</button>
			{onRemove && (
				<button
					onClick={(e) => { e.stopPropagation(); onRemove(); }}
					className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-danger-fill text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
					title={t("images.remove")}
				>
					<svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			)}
		</div>
	);
}
