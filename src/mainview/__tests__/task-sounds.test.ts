import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// happy-dom has no Web Audio implementation, so every test installs this fake
// AudioContext on `window` and asserts against the graph the module builds.
type FakeNode = { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
type FakeSource = FakeNode & {
	buffer: unknown;
	start: ReturnType<typeof vi.fn>;
	onended: (() => void) | null;
};
type FakeGain = FakeNode & { gain: { value: number } };

class FakeAudioContext {
	static instances: FakeAudioContext[] = [];
	state: AudioContextState = "running";
	destination = { name: "destination" } as unknown as AudioDestinationNode;
	sources: FakeSource[] = [];
	gains: FakeGain[] = [];
	decodeCalls: ArrayBuffer[] = [];
	resumeCalls = 0;

	constructor() {
		FakeAudioContext.instances.push(this);
	}

	resume = vi.fn(async () => {
		this.resumeCalls++;
		this.state = "running";
	});

	decodeAudioData = vi.fn((bytes: ArrayBuffer) => {
		this.decodeCalls.push(bytes);
		return Promise.resolve({ duration: 1.5, byteLength: bytes.byteLength } as unknown as AudioBuffer);
	});

	createBufferSource = vi.fn(() => {
		const source: FakeSource = {
			buffer: null,
			onended: null,
			start: vi.fn(),
			connect: vi.fn(),
			disconnect: vi.fn(),
		};
		this.sources.push(source);
		return source as unknown as AudioBufferSourceNode;
	});

	createGain = vi.fn(() => {
		const gain: FakeGain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
		this.gains.push(gain);
		return gain as unknown as GainNode;
	});
}

type SoundsModule = typeof import("../task-sounds");

// Every test gets a fresh module instance: unlock state, the decoded-buffer cache
// and the pending queue are all module-level globals.
async function loadModule(): Promise<SoundsModule> {
	vi.resetModules();
	return await import("../task-sounds");
}

function latestContext(): FakeAudioContext {
	const ctx = FakeAudioContext.instances[FakeAudioContext.instances.length - 1];
	if (!ctx) throw new Error("no AudioContext was constructed");
	return ctx;
}

// Playback is async (decode → resume → start) and the fire-and-forget callers
// (`playTaskCompletionSound`, the push handler, the queue flush) are not
// awaitable, so drain enough microtasks for the whole chain to land.
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

let audioElementPlay: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	FakeAudioContext.instances = [];
	(window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
	// The whole point of the fix: nothing may reach an <audio> element.
	audioElementPlay = vi
		.spyOn(window.HTMLMediaElement.prototype, "play")
		.mockResolvedValue(undefined as unknown as void);
});

afterEach(() => {
	audioElementPlay.mockRestore();
	delete (window as unknown as { AudioContext?: unknown }).AudioContext;
});

// Regression guard for the `views://` range-request bug (decision 057): task
// sounds must be inlined as base64 `data:` URLs (via the `?inline` import
// suffix), never served as separate files through the Electrobun `views://`
// scheme — and Web Audio decoding now reads those base64 bytes directly.
describe("task sound assets", () => {
	it("serves every sound as an inlined base64 data: URL", async () => {
		const mod = await loadModule();
		for (const def of Object.values(mod.SOUND_DEFS)) {
			expect(def.url.startsWith("data:audio/")).toBe(true);
			expect(def.url).toContain(";base64,");
		}
	});
});

// The sound plays in exactly one place per move: UI-initiated moves play it
// locally (and signal `clientPlayedSound` so the backend skips its push), while
// non-UI completions play it from the backend push. `playTaskCompletionSound`
// returns whether the UI owns the sound so the caller can suppress the push —
// this is what prevents the double-play in remote mode (desktop window + browser
// on the same machine both receiving a broadcast push).
describe("completion sound playback", () => {
	it("plays locally and reports the UI owns the sound when enabled", async () => {
		const mod = await loadModule();
		mod.setTaskCompletionSoundEnabled(true);
		expect(mod.playTaskCompletionSound("completed")).toBe(true);
		await settle();
		expect(latestContext().sources).toHaveLength(1);
		expect(latestContext().sources[0]?.start).toHaveBeenCalledTimes(1);
	});

	it("does not play and reports false when the setting is disabled", async () => {
		const mod = await loadModule();
		mod.setTaskCompletionSoundEnabled(false);
		expect(mod.playTaskCompletionSound("completed")).toBe(false);
		await settle();
		expect(FakeAudioContext.instances).toHaveLength(0);
	});

	it("plays the backend push (CLI / branch-merge / agent approval)", async () => {
		const mod = await loadModule();
		mod.playTaskSoundFromPush("completed");
		await settle();
		expect(latestContext().sources).toHaveLength(1);
	});

	it("rings for two different tasks completing back-to-back", async () => {
		const mod = await loadModule();
		mod.setTaskCompletionSoundEnabled(true);
		expect(mod.playTaskCompletionSound("completed")).toBe(true);
		expect(mod.playTaskCompletionSound("cancelled")).toBe(true);
		await settle();
		expect(latestContext().sources).toHaveLength(2);
	});

	it("applies the per-sound volume through a gain node", async () => {
		const mod = await loadModule();
		await mod.playTaskSound("cancelled");
		await settle();
		expect(latestContext().gains[0]?.gain.value).toBe(mod.SOUND_DEFS.cancelled.volume);
	});

	it("decodes each sound once and reuses the buffer", async () => {
		const mod = await loadModule();
		await mod.playTaskSound("completed");
		await mod.playTaskSound("completed");
		await settle();
		const ctx = latestContext();
		expect(ctx.decodeAudioData).toHaveBeenCalledTimes(1);
		expect(ctx.sources).toHaveLength(2);
	});
});

// Issue #1176: on macOS, WebKit promotes any <audio> element longer than 0.95s to
// the system "Now Playing" session, so our 1.3-1.5s chimes stole the hardware
// media keys from Spotify/Music — Play/Pause replayed the chime. Web Audio never
// creates a media element and never becomes a Now Playing candidate, so these
// two assertions are the actual regression guard for the reported bug.
describe("macOS media-key ownership", () => {
	it("never plays through an <audio> element", async () => {
		const mod = await loadModule();
		mod.initTaskSoundPlayback();
		await mod.playTaskSound("completed");
		window.dispatchEvent(new Event("pointerdown"));
		await settle();
		expect(audioElementPlay).not.toHaveBeenCalled();
		expect(document.querySelector("audio")).toBeNull();
	});

	it("releases the audio graph when the sound ends", async () => {
		const mod = await loadModule();
		await mod.playTaskSound("completed");
		await settle();
		const ctx = latestContext();
		const source = ctx.sources[0];
		const gain = ctx.gains[0];
		expect(source?.onended).toBeTypeOf("function");
		source?.onended?.();
		expect(source?.disconnect).toHaveBeenCalledTimes(1);
		expect(gain?.disconnect).toHaveBeenCalledTimes(1);
	});
});

// Autoplay policy: a context created before any user gesture starts suspended
// (desktop Chrome in remote mode — the `taskSound` push lands seconds after the
// user's "Approve" click, long after its transient activation expired). The sound
// is queued and flushed once a gesture resumes the context.
describe("autoplay unlock (remote desktop browsers)", () => {
	class SuspendedAudioContext extends FakeAudioContext {
		state: AudioContextState = "suspended";
		gestureSeen = false;

		resume = vi.fn(async () => {
			this.resumeCalls++;
			if (this.gestureSeen) this.state = "running";
		});
	}

	it("queues a sound while suspended and plays it on the next gesture", async () => {
		(window as unknown as { AudioContext: unknown }).AudioContext = SuspendedAudioContext;
		const mod = await loadModule();
		mod.initTaskSoundPlayback();

		await mod.playTaskSound("completed");
		await settle();
		const ctx = latestContext() as SuspendedAudioContext;
		expect(ctx.sources).toHaveLength(0);

		ctx.gestureSeen = true;
		window.dispatchEvent(new Event("pointerdown"));
		await settle();
		expect(ctx.state).toBe("running");
		expect(ctx.sources).toHaveLength(1);
	});

	it("does not construct a context before the first gesture or sound", async () => {
		const mod = await loadModule();
		mod.initTaskSoundPlayback();
		expect(FakeAudioContext.instances).toHaveLength(0);

		window.dispatchEvent(new Event("pointerdown"));
		await settle();
		expect(FakeAudioContext.instances).toHaveLength(1);
	});

	it("stays silent without crashing when Web Audio is unavailable", async () => {
		delete (window as unknown as { AudioContext?: unknown }).AudioContext;
		const mod = await loadModule();
		await expect(mod.playTaskSound("completed")).resolves.toBeUndefined();
		expect(audioElementPlay).not.toHaveBeenCalled();
	});
});
