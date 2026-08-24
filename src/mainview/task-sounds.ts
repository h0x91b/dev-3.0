// `?inline` forces Vite to emit these as base64 `data:` URLs instead of files
// served via the `views://` scheme, which cannot satisfy the Range requests
// WKWebView's media loader issues (decision 057).
import completedSoundUrl from "../assets/sounds/task-completed.mp3?inline";
import cancelledSoundUrl from "../assets/sounds/task-cancelled.mp3?inline";

type TaskSoundStatus = "completed" | "cancelled";

export const SOUND_DEFS: Record<TaskSoundStatus, { url: string; volume: number }> = {
	completed: { url: completedSoundUrl, volume: 0.3 },
	cancelled: { url: cancelledSoundUrl, volume: 0.7 },
};

// Task sounds play through an <audio> element, and the chimes are deliberately
// kept SHORT — under WebKit's 0.95s `isElementLongEnoughForMainContent`
// threshold, above which macOS promotes a media element to the system "Now
// Playing" session and the hardware Play/Pause key replays our chime instead of
// resuming Spotify (issue #1176). Both assets are 0.82s and a test guards that.
//
// Web Audio was tried instead (#1192) and is a dead end in the packaged app:
// in the Electrobun WKWebView an AudioContext reports `running`, advances
// `currentTime` and starts sources without error while producing NO audible
// output — measured with a real click, and unchanged after a media element had
// already played in the same page. `navigator.audioSession.type = "ambient"` is
// not a way around the Now Playing problem either: verified against live
// Spotify, the media keys were still taken. Duration is the only lever that
// works, so it is the one used. See
// decisions/2026/08/24/task-sounds-back-to-short-audio-elements.md.
export const NOW_PLAYING_THRESHOLD_SECONDS = 0.95;

const SOUND_UNLOCK_EVENTS: Array<keyof WindowEventMap> = ["pointerdown", "keydown", "touchstart"];
// A Set, not an array: the same status can be queued twice (the UI declines
// ownership, the backend then broadcasts its push back to us) and the user must
// hear one chime, not two.
const pendingQueue = new Set<TaskSoundStatus>();

let unlockHandlersInstalled = false;

// The sound plays in exactly one place per move:
//
//  - UI-initiated moves (drag, card menu, info panel, terminal toolbar) play it
//    locally and instantly via `playTaskCompletionSound`, then tell the backend
//    (`clientPlayedSound` on the moveTask RPC) to skip its `taskSound` push.
//    The push would otherwise fan out to EVERY connected renderer — a desktop
//    window AND a remote browser on the same machine — and play a second time.
//  - Non-UI completions (CLI, branch-merge auto-complete, agent approval) have no
//    renderer that played locally, so the backend pushes `taskSound` and
//    `playTaskSoundFromPush` plays it.
//
// The two paths are mutually exclusive at the source whenever the UI could
// actually start playback. When the browser's autoplay policy refuses (desktop
// Chrome in remote mode, where the push lands long after the click that
// authorised it) the sound is queued, the UI declines ownership and the push
// goes out — the queue is a Set, so that push echoing back cannot double the
// chime.

// Client-side mirror of the `playSoundOnTaskComplete` setting, kept in sync by
// App.tsx. The bun process also gates its `taskSound` push on the same setting;
// this lets the UI gate the *immediate* client-side playback without a round-trip.
let completionSoundEnabled = true;
// Set once a `play()` call is refused, cleared once one succeeds: the only
// honest signal we have about whether the next chime will be heard.
let autoplayBlocked = false;

export function setTaskCompletionSoundEnabled(enabled: boolean): void {
	completionSoundEnabled = enabled;
}

/**
 * Play the completion/cancellation sound immediately from the UI (respecting the
 * user setting). Returns true if the UI owns the sound for this move, so the
 * caller can pass `clientPlayedSound` to the backend and suppress the redundant
 * `taskSound` push. Returns false when the sound setting is off, or when the
 * last attempt was blocked by autoplay policy and this one can only be queued.
 */
export function playTaskCompletionSound(status: TaskSoundStatus): boolean {
	if (!completionSoundEnabled) return false;
	const owned = !autoplayBlocked;
	void playTaskSound(status);
	return owned;
}

/**
 * Handle a bun `taskSound` push. Fired for completions no renderer played
 * locally (CLI, branch-merge, agent approval), and for the ones a renderer
 * could not play.
 */
export function playTaskSoundFromPush(status: TaskSoundStatus): void {
	void playTaskSound(status);
}

/**
 * State of the audio pipeline, for the View → Debug sound probes. `blocked` is
 * what actually matters: everything else can look healthy while the browser is
 * refusing to start playback.
 */
export function taskSoundDiagnostics(): { blocked: boolean; queued: number; enabled: boolean } {
	return {
		blocked: autoplayBlocked,
		queued: pendingQueue.size,
		enabled: completionSoundEnabled,
	};
}

function flushPendingQueue(): void {
	const queued = [...pendingQueue];
	pendingQueue.clear();
	for (const status of queued) void playTaskSound(status);
}

// Installed once and never removed: the listeners exist to retry a sound the
// autoplay policy refused, and that can happen at any point in a session.
function installUnlockHandlers(): void {
	if (unlockHandlersInstalled || typeof window === "undefined") return;
	unlockHandlersInstalled = true;
	const retry = () => {
		if (pendingQueue.size > 0) flushPendingQueue();
	};
	for (const eventName of SOUND_UNLOCK_EVENTS) {
		window.addEventListener(eventName, retry, { passive: true });
	}
}

export function initTaskSoundPlayback(): void {
	installUnlockHandlers();
}

export async function playTaskSound(status: TaskSoundStatus): Promise<void> {
	if (typeof Audio === "undefined") return;
	// Arm the retry path first, so a refused sound is not lost.
	installUnlockHandlers();

	const def = SOUND_DEFS[status];
	// A fresh element per play, so two tasks finishing back-to-back overlap
	// instead of one cutting the other off. Dropped as soon as it ends.
	const el = new Audio(def.url);
	el.volume = def.volume;
	el.addEventListener("ended", () => el.remove(), { once: true });

	try {
		await el.play();
		autoplayBlocked = false;
	} catch (err) {
		autoplayBlocked = true;
		pendingQueue.add(status);
		console.warn("[task-sounds] playback refused", { status, error: String(err) });
	}
}
