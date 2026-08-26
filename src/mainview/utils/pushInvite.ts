/** One-time discoverability nudge; setup itself stays in Settings. */
import type { TFunction } from "../i18n";
import { OPEN_SETTINGS_SECTION_EVENT } from "../state";
import { toast } from "../toast";
import { storageIsWritable } from "./storage";
import { isSubscribed, pushReadiness } from "./webPush";

const DISMISSED_KEY = "dev3-push-invite-dismissed";

function usableStorage(): Storage | null {
	try {
		const storage = localStorage;
		return storageIsWritable(storage, `${DISMISSED_KEY}-probe`) ? storage : null;
	} catch {
		return null;
	}
}

/** Offer push once, and only where accepting can succeed. */
export async function maybeInvitePushEnrollment(t: TFunction): Promise<void> {
	const storage = usableStorage();
	if (!storage || storage.getItem(DISMISSED_KEY) === "1") return;
	if (!pushReadiness().ready) return;
	// A browser-level denial cannot be requested again from the page.
	if (typeof Notification === "undefined" || Notification.permission === "denied") return;
	if (await isSubscribed()) return;

	toast.info(t("push.inviteBody"), {
		durationMs: 15_000,
		source: "settings",
		onClick: () =>
			window.dispatchEvent(
				new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, {
					detail: { section: "notifications", anchor: "push-notifications" },
				}),
			),
	});
	// Offered once. Whether they take it or ignore it, we do not ask again.
	try {
		storage.setItem(DISMISSED_KEY, "1");
	} catch {
		// Storage filled up between the probe and now — the invite may return next
		// session, which is the mild half of the two failure modes.
	}
}
