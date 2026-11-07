import { FIRST_FRAME_TIME, primeFirstFrame } from "../video-first-frame";

function fakeVideo(state: { paused?: boolean; currentTime?: number; videoWidth?: number }) {
	const video = document.createElement("video");
	Object.defineProperty(video, "paused", { configurable: true, get: () => state.paused ?? true });
	Object.defineProperty(video, "videoWidth", { configurable: true, get: () => state.videoWidth ?? 640 });
	let time = state.currentTime ?? 0;
	Object.defineProperty(video, "currentTime", { configurable: true, get: () => time, set: (v: number) => { time = v; } });
	return video;
}

describe("primeFirstFrame", () => {
	it("seeks a paused, untouched video past zero so WebKit decodes its first frame", () => {
		const video = fakeVideo({});
		primeFirstFrame(video);
		expect(video.currentTime).toBe(FIRST_FRAME_TIME);
		expect(FIRST_FRAME_TIME).toBeGreaterThan(0);
	});

	it("leaves a video the user already started alone", () => {
		const video = fakeVideo({ paused: false });
		primeFirstFrame(video);
		expect(video.currentTime).toBe(0);
	});

	it("does not move a video already scrubbed elsewhere", () => {
		const video = fakeVideo({ currentTime: 12 });
		primeFirstFrame(video);
		expect(video.currentTime).toBe(12);
	});

	it("skips a file with no decodable picture", () => {
		const video = fakeVideo({ videoWidth: 0 });
		primeFirstFrame(video);
		expect(video.currentTime).toBe(0);
	});

	it("survives a stream that refuses to seek", () => {
		const video = fakeVideo({});
		Object.defineProperty(video, "currentTime", { configurable: true, get: () => 0, set: () => { throw new Error("not seekable"); } });
		expect(() => primeFirstFrame(video)).not.toThrow();
	});
});
