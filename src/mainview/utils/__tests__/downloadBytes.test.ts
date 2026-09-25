import { describe, expect, it } from "vitest";
import { assetFileName } from "../downloadBytes";

describe("assetFileName", () => {
	it("keeps a plain download name and falls back to the asset basename", () => {
		expect(assetFileName("Take A.mp3", "audio/A.mp3")).toBe("Take A.mp3");
		expect(assetFileName("", "audio/A.mp3")).toBe("A.mp3");
		expect(assetFileName(undefined, "audio/A.mp3")).toBe("A.mp3");
	});

	it("never lets a frame-supplied name carry a directory or control characters", () => {
		expect(assetFileName("../../etc/passwd", "audio/A.mp3")).toBe("passwd");
		expect(assetFileName("..\\x\\evil.mp3", "audio/A.mp3")).toBe("evil.mp3");
		expect(assetFileName("a\u0000b.mp3", "audio/A.mp3")).toBe("ab.mp3");
		expect(assetFileName("..", "audio/A.mp3")).toBe("A.mp3");
	});
});
