/**
 * The one-time nudge that makes push discoverable.
 *
 * The toggle itself belongs in Settings (durable configuration), but a control
 * nobody can find is a control nobody uses: enrolling takes four steps through
 * two nested screens, and testing showed a motivated user who knew the feature
 * existed still did not reach it.
 *
 * Shown as a toast rather than a modal on purpose — it is an offer, not a
 * decision the user has to make before continuing.
 */
import type { TFunction } from "../i18n";
import { toast } from "../toast";
import { isSubscribed, pushReadiness, subscribeToPush } from "./webPush";

const DISMISSED_KEY = "dev3-push-invite-dismissed";

function alreadyAnswered(): boolean {
	try {
		return localStorage.getItem(DISMISSED_KEY) === "1";
	} catch {
		// Private mode or blocked storage: better to stay silent than to nag on
		// every load, since we would have no way to remember a dismissal.
		return true;
	}
}

function remember(): void {
	try {
		localStorage.setItem(DISMISSED_KEY, "1");
	} catch {
		// Nothing to do — the invite simply may appear again next session.
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
	if (alreadyAnswered()) return;
	if (!pushReadiness().ready) return;
	// "denied" is a decision the user already made in the browser; re-asking is
	// noise, since the prompt will never appear again anyway.
	if (typeof Notification === "undefined" || Notification.permission === "denied") return;
	if (await isSubscribed()) return;

	toast.info(t("push.inviteBody"), {
		durationMs: 15_000,
		onClick: () => {
			remember();
			void (async () => {
				try {
					if (Notification.permission !== "granted") {
						const result = await Notification.requestPermission();
						if (result !== "granted") return;
					}
					await subscribeToPush();
					toast.success(t("push.inviteDone"));
				} catch (err) {
					toast.error(err instanceof Error ? err.message : String(err));
				}
			})();
		},
	});
	// Offered once. Whether they take it or ignore it, we do not ask again.
	remember();
}
