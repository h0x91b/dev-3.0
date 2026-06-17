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

// The UI plays the completion sound client-side the instant a card is dropped
// onto completed/cancelled (so it feels immediate), but the bun process ALSO
// pushes a `taskSound` event for the same move a moment later. Without a guard
// the same move would play twice. Swallow a repeat of the same status that
// arrives within this window of an actual playback.
const SOUND_DEDUPE_MS = 1500;
const lastPlayedAt = new Map<TaskSoundStatus, number>();

// Client-side mirror of the `playSoundOnTaskComplete` setting, kept in sync by
// App.tsx. The bun process also gates its `taskSound` push on the same setting;
// this lets the UI gate the *immediate* client-side playback without a round-trip.
let completionSoundEnabled = true;

export function setTaskCompletionSoundEnabled(enabled: boolean): void {
	completionSoundEnabled = enabled;
}

/**
 * Play the completion/cancellation sound immediately from the UI (respecting the
 * user setting). The matching bun `taskSound` push that follows is swallowed by
 * the dedupe guard, so the sound is heard exactly once.
 */
export function playTaskCompletionSound(status: TaskSoundStatus): void {
	if (!completionSoundEnabled) return;
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

	const last = lastPlayedAt.get(status);
	if (last !== undefined && Date.now() - last < SOUND_DEDUPE_MS) return;

	if (!canPlayImmediately()) {
		pendingQueue.push(status);
		return;
	}

	playbackUnlocked = true;
	lastPlayedAt.set(status, Date.now());

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
