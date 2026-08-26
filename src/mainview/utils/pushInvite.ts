/**
 * The one-time nudge that makes push discoverable.
 *
 * The toggle itself belongs in Settings (durable configuration), but a control
 * nobody can find is a control nobody uses: enrolling takes four steps through
 * two nested screens, and testing showed a motivated user who knew the feature
 * existed still did not reach it.
 *
 * Shown as a toast rather than a modal on purpose — it is an offer, not a
 * decision the user has to make before continuing. The toast only points at the
 * setting; permission and enrolment are durable multi-step setup and stay behind
 * the explicit controls in Settings → System → Notifications.
 */
import type { TFunction } from "../i18n";
import { OPEN_SETTINGS_SECTION_EVENT } from "../state";
import { toast } from "../toast";
import { isSubscribed, pushReadiness } from "./webPush";

const DISMISSED_KEY = "dev3-push-invite-dismissed";

/**
 * Storage we can actually write. A readable-but-unwritable store is the trap: we
 * would offer, fail to record the dismissal, and nag again on every load — so
 * treat it exactly like a store that cannot be read at all.
 */
function usableStorage(): Storage | null {
	try {
		const probe = `${DISMISSED_KEY}-probe`;
		localStorage.setItem(probe, "1");
		const ok = localStorage.getItem(probe) === "1";
		localStorage.removeItem(probe);
		return ok ? localStorage : null;
	} catch {
		return null;
	}
}

/**
 * Offer push exactly once, and only where accepting would actually work.
 *
 * Every condition here exists to avoid the failure that trains people to
 * dismiss prompts on sight: an offer that cannot succeed. On an iOS Safari tab
 * there is no notification API at all, and over plain http there is no service
 * worker — in both cases the honest answer is silence, with Settings explaining
 * why if the user goes looking.
 */
export async function maybeInvitePushEnrollment(t: TFunction): Promise<void> {
	const storage = usableStorage();
	if (!storage || storage.getItem(DISMISSED_KEY) === "1") return;
	if (!pushReadiness().ready) return;
	// "denied" is a decision the user already made in the browser; re-asking is
	// noise, since the prompt will never appear again anyway.
	if (typeof Notification === "undefined" || Notification.permission === "denied") return;
	if (await isSubscribed()) return;

	toast.info(t("push.inviteBody"), {
		durationMs: 15_000,
		source: "settings",
		onClick: () =>
			window.dispatchEvent(
				new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, {
					detail: { section: "system", anchor: "push-notifications" },
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
