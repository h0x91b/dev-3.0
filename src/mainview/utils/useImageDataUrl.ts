import { useEffect, useState } from "react";
import { api } from "../rpc";

/** Shared across every caller so the same file is read from disk once per session. */
const dataUrlCache = new Map<string, string>();

export interface ImageDataUrlState {
	dataUrl: string | null;
	loading: boolean;
	error: boolean;
}

/** Reads a local image file into a base64 data URL, cached by absolute path. */
export function useImageDataUrl(path: string): ImageDataUrlState {
	const [dataUrl, setDataUrl] = useState<string | null>(dataUrlCache.get(path) ?? null);
	const [error, setError] = useState(false);
	const [loading, setLoading] = useState(!dataUrlCache.has(path));

	useEffect(() => {
		const cached = dataUrlCache.get(path);
		if (cached) {
			setDataUrl(cached);
			setError(false);
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
			if (cancelled) return;
			setError(true);
			setLoading(false);
		});

		return () => { cancelled = true; };
	}, [path]);

	return { dataUrl, loading, error };
}
