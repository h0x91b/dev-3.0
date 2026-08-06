// `?inline` forces Vite to emit these as base64 `data:` URLs instead of files
// served via the `views://` scheme, which cannot satisfy the Range requests
// WKWebView's media loader issues (decision 057). Web Audio fetches nothing —
// the bytes are decoded straight out of the base64 payload — but keeping the
// imports inlined avoids reintroducing a `views://` asset for audio.
import completedSoundUrl from "../assets/sounds/task-completed.mp3?inline";
import cancelledSoundUrl from "../assets/sounds/task-cancelled.mp3?inline";

type TaskSoundStatus = "completed" | "cancelled";

export const SOUND_DEFS: Record<TaskSoundStatus, { url: string; volume: number }> = {
	completed: { url: completedSoundUrl, volume: 0.3 },
	cancelled: { url: cancelledSoundUrl, volume: 0.7 },
};

// Task sounds MUST go through Web Audio, never an <audio> element. On macOS,
// WebKit makes any <audio> longer than 0.95s the system "Now Playing" session
// (`MediaElementSession::isElementLongEnoughForMainContent`), so our 1.3-1.5s
// chimes hijacked the hardware media keys from Spotify/Music: Play/Pause
// replayed the chime instead of resuming the real player (issue #1176). An
// AudioContext is only Now Playing eligible when the page opts into
// `navigator.audioSession.type = "playback"`, which we never do — so it can
// neither steal the keys nor interrupt other audio (it mixes as ambient sound).
// Chrome behaves the same way: WebAudio is ambient, an <audio> element is not.
const SOUND_UNLOCK_EVENTS: Array<keyof WindowEventMap> = ["pointerdown", "keydown", "touchstart"];
const pendingQueue: TaskSoundStatus[] = [];
const buffers = new Map<TaskSoundStatus, AudioBuffer>();
const decoding = new Map<TaskSoundStatus, Promise<AudioBuffer | null>>();

let context: AudioContext | null = null;
let unlockHandlersInstalled = false;

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

/**
 * State of the audio pipeline, for the View → Debug sound probes. Never creates
 * the context — an untouched app must report `none`, not be primed by looking.
 */
export function taskSoundDiagnostics(): { context: string; buffers: number; queued: number; enabled: boolean } {
	return {
		context: context?.state ?? "none",
		buffers: buffers.size,
		queued: pendingQueue.length,
		enabled: completionSoundEnabled,
	};
}

function audioContextCtor(): typeof AudioContext | undefined {
	if (typeof window === "undefined") return undefined;
	const scoped = window as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
	return scoped.AudioContext ?? scoped.webkitAudioContext;
}

// Created lazily, never closed: a long-lived context stays unlocked, so later
// push-driven sounds (which arrive seconds after any user gesture) can start
// without another gesture. Constructing it on demand rather than at import also
// keeps Chrome from logging its "AudioContext was not allowed to start" warning
// on a page the user has not interacted with yet.
function ensureContext(): AudioContext | null {
	if (context) return context;
	const Ctor = audioContextCtor();
	if (!Ctor) return null;
	try {
		context = new Ctor();
	} catch (err) {
		console.warn("[task-sounds] no audio context", { error: String(err) });
		return null;
	}
	return context;
}

function decodeBytes(url: string): ArrayBuffer {
	const marker = ";base64,";
	const at = url.indexOf(marker);
	if (!url.startsWith("data:") || at === -1) {
		throw new Error("task sound must be an inlined base64 data: URL");
	}
	const binary = atob(url.slice(at + marker.length));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

// Safari/WKWebView only gained promise-based `decodeAudioData` in 14.1 and still
// supports the callback form; accept whichever the engine hands back.
function decodeAudioData(ctx: AudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
	return new Promise((resolve, reject) => {
		const returned = ctx.decodeAudioData(bytes, resolve, reject) as Promise<AudioBuffer> | undefined;
		if (returned && typeof returned.then === "function") returned.then(resolve, reject);
	});
}

function loadBuffer(ctx: AudioContext, status: TaskSoundStatus): Promise<AudioBuffer | null> {
	const ready = buffers.get(status);
	if (ready) return Promise.resolve(ready);

	const inFlight = decoding.get(status);
	if (inFlight) return inFlight;

	const pending = Promise.resolve()
		.then(() => decodeAudioData(ctx, decodeBytes(SOUND_DEFS[status].url)))
		.then((buffer) => {
			buffers.set(status, buffer);
			return buffer;
		})
		.catch((err) => {
			console.warn("[task-sounds] decode failed", { status, error: String(err) });
			return null;
		})
		.finally(() => {
			decoding.delete(status);
		});

	decoding.set(status, pending);
	return pending;
}

async function resume(ctx: AudioContext): Promise<boolean> {
	if (ctx.state === "running") return true;
	try {
		await ctx.resume();
	} catch {
		// Autoplay policy: the context stays suspended until a user gesture.
	}
	// Cast: TS keeps `state` narrowed from the early return above, but `resume()`
	// is exactly what changes it.
	return (ctx.state as AudioContextState) === "running";
}

function startSound(ctx: AudioContext, status: TaskSoundStatus, buffer: AudioBuffer): void {
	const source = ctx.createBufferSource();
	source.buffer = buffer;
	const gain = ctx.createGain();
	gain.gain.value = SOUND_DEFS[status].volume;
	source.connect(gain);
	gain.connect(ctx.destination);
	// Tear the graph down when the chime finishes so nothing outlives playback.
	source.onended = () => {
		source.disconnect();
		gain.disconnect();
	};
	source.start();
}

function flushPendingQueue(): void {
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
		const ctx = ensureContext();
		if (!ctx) return;
		// Decode inside the gesture too, so the first sound needs no round-trip.
		for (const status of Object.keys(SOUND_DEFS) as TaskSoundStatus[]) {
			void loadBuffer(ctx, status);
		}
		void resume(ctx).then((running) => {
			if (!running) return;
			flushPendingQueue();
			for (const eventName of SOUND_UNLOCK_EVENTS) {
				window.removeEventListener(eventName, unlock);
			}
			unlockHandlersInstalled = false;
		});
	};

	for (const eventName of SOUND_UNLOCK_EVENTS) {
		window.addEventListener(eventName, unlock, { passive: true });
	}
}

export function initTaskSoundPlayback(): void {
	installUnlockHandlers();
}

export async function playTaskSound(status: TaskSoundStatus): Promise<void> {
	const ctx = ensureContext();
	if (!ctx) return;
	installUnlockHandlers();

	const buffer = await loadBuffer(ctx, status);
	if (!buffer) return;

	if (!(await resume(ctx))) {
		pendingQueue.push(status);
		return;
	}

	try {
		startSound(ctx, status, buffer);
	} catch (err) {
		console.warn("[task-sounds] playback failed", { status, error: String(err) });
	}
}
