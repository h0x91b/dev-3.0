// `?inline` forces Vite to emit these as base64 `data:` URLs instead of files
// served via the `views://` scheme. WKWebView's media loader (AppleCoreMedia)
// fetches <audio> sources with a Range request (`bytes=0-1`), which the
// Electrobun `views://` scheme handler does not satisfy — the request returns no
// body and playback fails with `NotSupportedError`. A data: URL sidesteps the
// scheme handler entirely, so playback works in packaged builds on every OS.
import completedSoundUrl from "../assets/sounds/task-completed.mp3?inline";
import cancelledSoundUrl from "../assets/sounds/task-cancelled.mp3?inline";

type TaskSoundStatus = "completed" | "cancelled";

export const SOUND_DEFS: Record<TaskSoundStatus, { url: string; volume: number }> = {
	completed: { url: completedSoundUrl, volume: 0.3 },
	cancelled: { url: cancelledSoundUrl, volume: 0.7 },
};

const SOUND_UNLOCK_EVENTS: Array<keyof WindowEventMap> = ["pointerdown", "keydown", "touchstart"];
const pendingQueue: TaskSoundStatus[] = [];
const templates = new Map<TaskSoundStatus, HTMLAudioElement>();

// The completion/cancel sound is played in exactly one place per move:
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
// Because the two paths are mutually exclusive at the source, no client-side
// echo de-dup is needed.

// Client-side mirror of the `playSoundOnTaskComplete` setting, kept in sync by
// App.tsx. The bun process also gates its `taskSound` push on the same setting;
// this lets the UI gate the *immediate* client-side playback without a round-trip.
let completionSoundEnabled = true;

export function setTaskCompletionSoundEnabled(enabled: boolean): void {
	completionSoundEnabled = enabled;
}

/**
 * Play the completion/cancellation sound immediately from the UI (respecting the
 * user setting). Returns true if the UI owns the sound for this move, so the
 * caller can pass `clientPlayedSound` to the backend and suppress the redundant
 * `taskSound` push. Returns false when the sound setting is off (the backend is
 * gated on the same setting, so nothing plays either way).
 */
export function playTaskCompletionSound(status: TaskSoundStatus): boolean {
	if (!completionSoundEnabled) return false;
	void playTaskSound(status);
	return true;
}

/**
 * Handle a bun `taskSound` push. Only fired for completions no renderer played
 * locally (CLI, branch-merge, agent approval), so it always plays.
 */
export function playTaskSoundFromPush(status: TaskSoundStatus): void {
	void playTaskSound(status);
}

let unlockHandlersInstalled = false;
let playbackUnlocked = false;

function canPlayImmediately(): boolean {
	if (playbackUnlocked) return true;
	if (typeof navigator === "undefined" || !("userActivation" in navigator)) return true;
	return navigator.userActivation?.hasBeenActive === true;
}

function getAudioTemplate(status: TaskSoundStatus): HTMLAudioElement {
	const existing = templates.get(status);
	if (existing) return existing;

	const audio = new Audio(SOUND_DEFS[status].url);
	audio.preload = "auto";
	audio.load();
	templates.set(status, audio);
	return audio;
}

function flushPendingQueue(): void {
	if (!canPlayImmediately()) return;
	playbackUnlocked = true;

	while (pendingQueue.length > 0) {
		const status = pendingQueue.shift();
		if (!status) continue;
		void playTaskSound(status);
	}
}

function installUnlockHandlers(): void {
	if (unlockHandlersInstalled || typeof window === "undefined") return;
	unlockHandlersInstalled = true;

	const unlock = () => {
		flushPendingQueue();
		if (pendingQueue.length === 0) {
			for (const eventName of SOUND_UNLOCK_EVENTS) {
				window.removeEventListener(eventName, unlock);
			}
			unlockHandlersInstalled = false;
		}
	};

	for (const eventName of SOUND_UNLOCK_EVENTS) {
		window.addEventListener(eventName, unlock, { passive: true });
	}
}

export function initTaskSoundPlayback(): void {
	for (const status of Object.keys(SOUND_DEFS) as TaskSoundStatus[]) {
		getAudioTemplate(status);
	}
	installUnlockHandlers();
}

export async function playTaskSound(status: TaskSoundStatus): Promise<void> {
	initTaskSoundPlayback();

	if (!canPlayImmediately()) {
		pendingQueue.push(status);
		return;
	}

	playbackUnlocked = true;

	const template = getAudioTemplate(status);
	const audio = template.cloneNode() as HTMLAudioElement;
	audio.volume = SOUND_DEFS[status].volume;

	try {
		await audio.play();
	} catch (err) {
		console.warn("[task-sounds] playback failed", { status, error: String(err) });
		pendingQueue.push(status);
		playbackUnlocked = false;
		installUnlockHandlers();
	}
}
