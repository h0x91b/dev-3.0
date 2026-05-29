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
