/**
 * Say, once, that artifacts were switched to the popup because the previous
 * session stopped responding with an artifact open — and hand the user the
 * switch, so the decision stays theirs.
 *
 * The "once" lives on the host: reading the notice clears it (see
 * `bun/artifact-freeze-recovery.ts`), so a reload, a second window or a remote tab
 * cannot raise it twice, and nothing has to be remembered in browser storage.
 *
 * Wording is deliberately association-only: the session stopped responding while
 * an artifact was open. Nothing here claims the artifact caused it.
 */
import type { TFunction } from "../i18n";
import { api } from "../rpc";
import { OPEN_SETTINGS_SECTION_EVENT } from "../state";
import { toast } from "../toast";

export async function maybeShowArtifactFreezeNotice(t: TFunction): Promise<void> {
	let notice: { freezeAt: number } | null = null;
	try {
		notice = await api.request.consumeArtifactFreezeNotice({});
	} catch {
		// Diagnostics-driven courtesy — never worth an error on screen.
		return;
	}
	if (!notice) return;

	toast.info(t("settings.artifactPopupAutoEnabled"), {
		durationMs: 30_000,
		source: "settings",
		onClick: () =>
			window.dispatchEvent(
				new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, {
					detail: { section: "behavior", anchor: "artifact-popup" },
				}),
			),
	});
}
