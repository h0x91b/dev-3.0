import { useEffect, useState } from "react";
import type { TFunction } from "../i18n";
import { api } from "../rpc";
import UpdatePopoverSimulatorModal from "./UpdatePopoverSimulatorModal";

/**
 * Dev-only entry point for the update-popover simulator, shown in Settings →
 * Developer Tools next to "Install dev3 CLI". Gated to the `dev` build channel
 * (`bun run dev` from source) so this developer preview never leaks into
 * end-user (stable/canary) builds — UX bible: dev surfaces must not leak to users.
 */
export default function UpdatePopoverSimulator({ t }: { t: TFunction }) {
	const [isDev, setIsDev] = useState(false);
	const [open, setOpen] = useState(false);

	useEffect(() => {
		let cancelled = false;
		api.request
			.getAppVersion?.()
			.then((v) => {
				if (!cancelled) setIsDev(v.buildChannel === "dev");
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);

	if (!isDev) return null;

	return (
		<div className="mt-4 pt-4 border-t border-edge">
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="px-4 py-2 bg-raised hover:bg-raised-hover text-fg text-sm rounded-lg transition-colors border border-edge"
			>
				{t("settings.previewUpdatePopover")}
			</button>
			<p className="text-fg-muted text-xs mt-1">{t("settings.previewUpdatePopoverDesc")}</p>
			{open && <UpdatePopoverSimulatorModal onClose={() => setOpen(false)} />}
		</div>
	);
}
