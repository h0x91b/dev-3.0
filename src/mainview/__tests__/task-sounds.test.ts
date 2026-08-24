import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SoundsModule = typeof import("../task-sounds");

// The module keeps its retry listeners on `window` for the app's whole life, so
// resetting the module registry is not enough — a previous test's listeners would
// still answer the next test's gesture. Track and drop them between tests.
const installedListeners: Array<[string, EventListenerOrEventListenerObject]> = [];
const realAddEventListener = window.addEventListener.bind(window);

// Every test gets a fresh module instance: the pending queue and the
// autoplay-blocked flag are module-level globals.
async function loadModule(): Promise<SoundsModule> {
	vi.resetModules();
	return await import("../task-sounds");
}

// Playback is async and the fire-and-forget callers (`playTaskCompletionSound`,
// the push handler, the queue flush) are not awaitable, so drain enough
// microtasks for the whole chain to land.
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function gesture(): Promise<void> {
	window.dispatchEvent(new Event("pointerdown"));
	await settle();
}

let play: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	installedListeners.length = 0;
	window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, opts?: unknown) => {
		installedListeners.push([type, listener]);
		realAddEventListener(type as keyof WindowEventMap, listener as EventListener, opts as AddEventListenerOptions);
	}) as typeof window.addEventListener;
	play = vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined as unknown as void);
});

afterEach(() => {
	window.addEventListener = realAddEventListener;
	for (const [type, listener] of installedListeners) window.removeEventListener(type, listener);
	installedListeners.length = 0;
	play.mockRestore();
});

/**
 * Duration of a constant-bitrate MPEG audio payload, read from its own first
 * frame header rather than from whatever tool produced the file: bitrate and
 * sample rate come out of the bitstream, and the duration follows from the byte
 * count. Independent of ffmpeg, which is what makes it a guard.
 */
function mp3Seconds(dataUrl: string): number {
	const marker = ";base64,";
	const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(marker) + marker.length)), (c) => c.charCodeAt(0));
	const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
	const rates = [44100, 48000, 32000];
	for (let i = 0; i + 3 < bytes.length; i++) {
		// Frame sync: 11 set bits, then MPEG-1 Layer III.
		if (bytes[i] !== 0xff || (bytes[i + 1]! & 0xe0) !== 0xe0) continue;
		if (((bytes[i + 1]! >> 3) & 0x03) !== 0x03 || ((bytes[i + 1]! >> 1) & 0x03) !== 0x01) continue;
		const kbps = bitrates[(bytes[i + 2]! >> 4) & 0x0f]!;
		const hz = rates[(bytes[i + 2]! >> 2) & 0x03]!;
		if (!kbps || !hz) continue;
		return ((bytes.length - i) * 8) / (kbps * 1000);
	}
	throw new Error("no MPEG-1 Layer III frame header found");
}

// Regression guard for the `views://` range-request bug (decision 057): task
// sounds must be inlined as base64 `data:` URLs (via the `?inline` import
// suffix), never served as separate files through the Electrobun `views://`
// scheme.
describe("task sound assets", () => {
	it("serves every sound as an inlined base64 data: URL", async () => {
		const mod = await loadModule();
		for (const def of Object.values(mod.SOUND_DEFS)) {
			expect(def.url.startsWith("data:audio/")).toBe(true);
			expect(def.url).toContain(";base64,");
		}
	});

	// Issue #1176: macOS promotes any media element longer than WebKit's
	// `isElementLongEnoughForMainContent` threshold to the system "Now Playing"
	// session, and the hardware Play/Pause key then replays our chime instead of
	// resuming Spotify. Since the chimes play through an <audio> element, staying
	// under that threshold is the ONLY thing keeping the media keys where they
	// belong — `navigator.audioSession.type = "ambient"` was measured against
	// live Spotify and does not help. Re-cutting a chime longer than this breaks
	// the media keys for every macOS user.
	it("keeps every chime under the Now Playing threshold", async () => {
		const mod = await loadModule();
		for (const [status, def] of Object.entries(mod.SOUND_DEFS)) {
			const seconds = mp3Seconds(def.url);
			expect(seconds, `${status} chime is ${seconds.toFixed(2)}s`).toBeLessThan(mod.NOW_PLAYING_THRESHOLD_SECONDS);
		}
	});
});

describe("completion sound playback", () => {
	it("plays locally and reports the UI owns the sound when enabled", async () => {
		const mod = await loadModule();
		mod.setTaskCompletionSoundEnabled(true);
		expect(mod.playTaskCompletionSound("completed")).toBe(true);
		await settle();
		expect(play).toHaveBeenCalledTimes(1);
	});

	it("does not play and reports false when the setting is disabled", async () => {
		const mod = await loadModule();
		mod.setTaskCompletionSoundEnabled(false);
		expect(mod.playTaskCompletionSound("completed")).toBe(false);
		await settle();
		expect(play).not.toHaveBeenCalled();
	});

	it("plays the backend push (CLI / branch-merge / agent approval)", async () => {
		const mod = await loadModule();
		mod.playTaskSoundFromPush("completed");
		await settle();
		expect(play).toHaveBeenCalledTimes(1);
	});

	it("rings for two different tasks completing back-to-back", async () => {
		const mod = await loadModule();
		mod.setTaskCompletionSoundEnabled(true);
		expect(mod.playTaskCompletionSound("completed")).toBe(true);
		expect(mod.playTaskCompletionSound("cancelled")).toBe(true);
		await settle();
		expect(play).toHaveBeenCalledTimes(2);
	});

	it("applies the per-sound volume to the element", async () => {
		const mod = await loadModule();
		const volumes: number[] = [];
		play.mockImplementation(function (this: HTMLMediaElement) {
			volumes.push(this.volume);
			return Promise.resolve();
		} as never);
		await mod.playTaskSound("cancelled");
		expect(volumes).toEqual([mod.SOUND_DEFS.cancelled.volume]);
	});

	it("stays silent without crashing when Audio is unavailable", async () => {
		const original = window.Audio;
		// @ts-expect-error — exercising an engine without media elements at all.
		delete window.Audio;
		try {
			const mod = await loadModule();
			await expect(mod.playTaskSound("completed")).resolves.toBeUndefined();
		} finally {
			window.Audio = original;
		}
	});
});

// Autoplay policy: desktop Chrome in remote mode refuses playback when the
// `taskSound` push lands seconds after the user's "Approve" click, long after
// its transient activation expired (#1018). The sound is queued and retried on
// the next interaction.
describe("autoplay refusal (remote desktop browsers)", () => {
	it("queues a refused sound and plays it on the next gesture", async () => {
		play.mockRejectedValueOnce(new Error("NotAllowedError"));
		const mod = await loadModule();
		mod.initTaskSoundPlayback();

		await mod.playTaskSound("completed");
		expect(mod.taskSoundDiagnostics()).toMatchObject({ blocked: true, queued: 1 });

		await gesture();
		expect(play).toHaveBeenCalledTimes(2);
		expect(mod.taskSoundDiagnostics()).toMatchObject({ blocked: false, queued: 0 });
	});

	it("declines ownership while blocked, so the backend push still fans out", async () => {
		play.mockRejectedValueOnce(new Error("NotAllowedError"));
		const mod = await loadModule();
		mod.setTaskCompletionSoundEnabled(true);
		await mod.playTaskSound("completed");

		expect(mod.playTaskCompletionSound("cancelled")).toBe(false);
	});

	it("collapses a declined sound and its echoing push into one chime", async () => {
		play.mockRejectedValue(new Error("NotAllowedError"));
		const mod = await loadModule();
		mod.initTaskSoundPlayback();
		await mod.playTaskSound("completed");
		mod.playTaskSoundFromPush("completed");
		await settle();
		expect(mod.taskSoundDiagnostics().queued).toBe(1);

		play.mockResolvedValue(undefined as unknown as void);
		await gesture();
		expect(mod.taskSoundDiagnostics().queued).toBe(0);
	});

	it("does not retry on a gesture when nothing is queued", async () => {
		const mod = await loadModule();
		mod.initTaskSoundPlayback();
		await gesture();
		expect(play).not.toHaveBeenCalled();
	});
});
