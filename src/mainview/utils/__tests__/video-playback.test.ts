import { describe, expect, it } from "vitest";
import { FrameRateMeter, PLAYBACK_RATES, estimateFps, knownFrameRate, rememberFrameRate, frameAt, frameSeekTime, stepPlaybackRate, timelinePercent } from "../video-playback";

describe("playback rate stepping", () => {
	it("walks the offered speeds and stops at both ends", () => {
		expect(PLAYBACK_RATES[0]).toBe(0.25);
		expect(stepPlaybackRate(1, 1)).toBe(1.25);
		expect(stepPlaybackRate(1, -1)).toBe(0.75);
		expect(stepPlaybackRate(2, 1)).toBe(2);
		expect(stepPlaybackRate(0.25, -1)).toBe(0.25);
	});

	it("snaps an off-list rate to its neighbour", () => {
		expect(stepPlaybackRate(1.1, 1)).toBe(1.25);
		expect(stepPlaybackRate(1.1, -1)).toBe(1);
	});
});

describe("frame rate estimate", () => {
	it("needs a few samples before it commits", () => {
		expect(estimateFps([1 / 30, 1 / 30])).toBeNull();
	});

	it("snaps near-standard rates and keeps odd ones", () => {
		expect(estimateFps([1 / 24, 1 / 24, 1 / 24, 1 / 24])).toBe(24);
		expect(estimateFps([1 / 29.97, 1 / 29.97, 1 / 29.97])).toBe(29.97);
		expect(estimateFps([1 / 15, 1 / 15, 1 / 15])).toBe(15);
	});

	it("ignores a dropped-frame gap through the median", () => {
		expect(estimateFps([1 / 60, 1 / 60, 2 / 60, 1 / 60, 1 / 60])).toBe(60);
	});

	it("only counts frames presented back to back", () => {
		const meter = new FrameRateMeter();
		meter.feed(0, 1);
		meter.feed(0.04, 2);
		meter.feed(0.2, 6); // skipped frames — not a gap of one frame
		meter.feed(0.24, 7);
		meter.reset();
		meter.feed(5, 8); // after a seek
		meter.feed(5.04, 9);
		expect(meter.fps).toBe(25);
	});
});

describe("frame rate meter stability", () => {
	function play(meter: FrameRateMeter, fps: number, frames: number, rate = 1, start = 0) {
		for (let i = 0; i < frames; i++) meter.feed(start + i / fps, start * fps + i + 1, rate);
	}

	it("ignores anything but 1x, where dropped frames would read as a lower rate", () => {
		const meter = new FrameRateMeter();
		// 2x on a 60 fps clip with every other frame dropped: gaps of 1/30 between consecutive presentations.
		for (let i = 0; i < 40; i++) meter.feed(i / 30, i + 1, 2);
		expect(meter.fps).toBeNull();
		play(meter, 60, 10);
		expect(meter.fps).toBe(60);
	});

	it("is stable only after enough agreeing samples", () => {
		const meter = new FrameRateMeter();
		play(meter, 25, 8);
		expect(meter.stable).toBe(false);
		play(meter, 25, 20, 1, 1);
		expect(meter.stable).toBe(true);
		expect(meter.fps).toBe(25);
	});

	it("remembers a settled rate per clip", () => {
		expect(knownFrameRate("clip-x")).toBeNull();
		rememberFrameRate("clip-x", 59.94);
		expect(knownFrameRate("clip-x")).toBe(59.94);
	});
});

describe("frame addressing", () => {
	it("names the frame under the playhead and seeks to its middle", () => {
		expect(frameAt(1, 30)).toBe(30);
		expect(frameAt(frameSeekTime(30, 30, 10), 30)).toBe(30);
		expect(frameAt(frameSeekTime(31, 30, 10), 30)).toBe(31);
		expect(frameSeekTime(-4, 30, 10)).toBeCloseTo(0.5 / 30);
	});

	it("never seeks past the last frame", () => {
		expect(frameSeekTime(10_000, 30, 2)).toBeCloseTo(2 - 0.5 / 30);
		expect(frameSeekTime(3, 30, Number.NaN)).toBeCloseTo(3.5 / 30);
	});

	it("places markers along the scrubber", () => {
		expect(timelinePercent(5, 20)).toBe(25);
		expect(timelinePercent(30, 20)).toBe(100);
		expect(timelinePercent(5, Number.NaN)).toBe(0);
	});
});
