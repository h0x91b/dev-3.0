import { useState, useEffect } from "react";
import { api } from "../rpc";
import { useT } from "../i18n";

// Module-level cache for base64 data URLs
const dataUrlCache = new Map<string, string>();

interface ImageThumbnailProps {
	path: string;
	onClick: () => void;
}

export function ImageThumbnail({ path, onClick }: ImageThumbnailProps) {
	const t = useT();
	const [dataUrl, setDataUrl] = useState<string | null>(dataUrlCache.get(path) ?? null);
	const [error, setError] = useState(false);
	const [loading, setLoading] = useState(!dataUrlCache.has(path));

	useEffect(() => {
		if (dataUrlCache.has(path)) {
			setDataUrl(dataUrlCache.get(path)!);
			setLoading(false);
			return;
		}

		let cancelled = false;
		setLoading(true);
		setError(false);

		api.request.readImageBase64({ path }).then((result) => {
			if (cancelled) return;
			if (result) {
				dataUrlCache.set(path, result.dataUrl);
				setDataUrl(result.dataUrl);
			} else {
				setError(true);
			}
			setLoading(false);
		}).catch(() => {
			if (!cancelled) {
				setError(true);
				setLoading(false);
			}
		});

		return () => { cancelled = true; };
	}, [path]);

	const filename = path.split("/").pop() ?? path;

	if (loading) {
		return (
			<div className="flex-shrink-0 w-[100px] h-[80px] rounded-lg bg-elevated animate-pulse flex items-center justify-center">
				<span className="text-[10px] text-fg-muted">{t("images.loading")}</span>
			</div>
		);
	}

	if (error || !dataUrl) {
		return (
			<div className="flex-shrink-0 w-[100px] h-[80px] rounded-lg bg-elevated border border-danger/30 flex items-center justify-center">
				<span className="text-[10px] text-danger">{t("images.loadFailed")}</span>
			</div>
		);
	}

	return (
		<button
			onClick={onClick}
			className="flex-shrink-0 flex flex-col items-center gap-0.5 group cursor-pointer"
			title={filename}
		>
			<img
				src={dataUrl}
				alt={filename}
				className="max-h-[80px] max-w-[120px] rounded-lg border border-edge group-hover:border-accent/50 transition-colors object-contain"
			/>
			<span className="text-[9px] text-fg-muted truncate max-w-[120px]">{filename}</span>
		</button>
	);
}
