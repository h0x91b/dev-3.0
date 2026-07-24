import { describe, expect, it } from "vitest";
import {
	MultiViewUnsupportedError,
	NativeAdapterError,
	NativeSessionNotFoundError,
	NativeViewGoneError,
} from "../errors";

describe("native adapter errors", () => {
	it("are catchable typed Errors carrying a discriminated code", () => {
		const notFound = new NativeSessionNotFoundError("alpha");
		const gone = new NativeViewGoneError("alpha", "alpha:0");
		const multi = new MultiViewUnsupportedError("splitView");

		for (const err of [notFound, gone, multi]) {
			expect(err).toBeInstanceOf(Error);
			expect(err).toBeInstanceOf(NativeAdapterError);
		}
		expect(notFound.code).toBe("session-not-found");
		expect(gone.code).toBe("view-gone");
		expect(multi.code).toBe("multi-view-unsupported");
	});

	it("names each subclass and surfaces its context", () => {
		const notFound = new NativeSessionNotFoundError("alpha");
		expect(notFound.name).toBe("NativeSessionNotFoundError");
		expect(notFound.sessionId).toBe("alpha");

		const gone = new NativeViewGoneError("alpha", "alpha:1");
		expect(gone.viewId).toBe("alpha:1");
		expect(gone.message).toContain("alpha:1");

		const multi = new MultiViewUnsupportedError("focusView");
		expect(multi.message).toContain("LAY-003");
	});

	it("can be discriminated by code after being thrown and caught", () => {
		const codes: string[] = [];
		for (const throwing of [
			() => {
				throw new NativeSessionNotFoundError("x");
			},
			() => {
				throw new MultiViewUnsupportedError("splitView");
			},
		]) {
			try {
				throwing();
			} catch (err) {
				if (err instanceof NativeAdapterError) codes.push(err.code);
			}
		}
		expect(codes).toEqual(["session-not-found", "multi-view-unsupported"]);
	});
});
