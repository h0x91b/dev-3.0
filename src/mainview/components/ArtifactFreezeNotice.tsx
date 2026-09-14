import { useEffect } from "react";
import type { TFunction } from "../i18n";
import { maybeShowArtifactFreezeNotice } from "../utils/artifactFreezeNotice";

/** Raises the popup-mode notice once per recovery, a beat after the app settles. */
export default function ArtifactFreezeNotice({ t }: { t: TFunction }) {
	useEffect(() => {
		const timer = setTimeout(() => void maybeShowArtifactFreezeNotice(t), 3_000);
		return () => clearTimeout(timer);
	}, [t]);

	return null;
}
